const express = require('express');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}

/**
 * Simple in-memory mutex.
 * Express/Node is single-threaded, but an `async` handler can still
 * "pause" (during the JSON body read, or between the read and write of
 * data.json) and let a second request run its own read before the
 * first request's write has landed. That's a classic read-modify-write
 * race: two requests both read the old list, both push their own
 * message onto it, and whichever one writes LAST wins — silently
 * erasing the other person's message (or a "mark as seen" update
 * erasing a message that was sent in between the read and the write).
 * This queue forces every data.json mutation to run one at a time.
 */
let writeQueue = Promise.resolve();
function withLock(fn) {
  const run = writeQueue.then(() => fn());
  // keep the chain alive even if fn() rejects, so later ops still run
  writeQueue = run.catch(() => {});
  return run;
}

// ---------- Push notifications (Web Push, VAPID) ----------
// Same two-person roster as the client (index.html) — only used here to
// pick a display name for the notification title.
const MEMBERS = {
  "8879883811": { name: "Bablu" },
  "8591200109": { name: "Chunnu" }
};

// VAPID keys are generated once and cached in data.json. Note: on Render's
// free tier data.json resets on redeploy/long-inactivity restart (see
// README) — when that happens these keys regenerate too, which silently
// invalidates any push subscriptions saved with the old key. The app
// re-subscribes automatically next time each phone opens Jeeru, so this
// just means a brief gap in push notifications after such a reset, not a
// crash.
function getOrCreateVapidKeys() {
  const data = loadData();
  if (data.vapidKeys) {
    try { return JSON.parse(data.vapidKeys); } catch (e) { /* fall through */ }
  }
  const keys = webpush.generateVAPIDKeys();
  data.vapidKeys = JSON.stringify(keys);
  saveData(data);
  return keys;
}
const VAPID_KEYS = getOrCreateVapidKeys();
webpush.setVapidDetails('mailto:jeeru-app@example.com', VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

const PUSH_SUB_KEY = 'push-subscriptions';

function loadPushSubs(data) {
  if (!data[PUSH_SUB_KEY]) return {};
  try { return JSON.parse(data[PUSH_SUB_KEY]); } catch (e) { return {}; }
}

// A handful of playful, non-spoilery notification lines — never the actual
// message text, just "so-and-so sent something" with a bit of personality.
const NOTIFY_TEMPLATES = [
  "{name} ne kuch bheja hai 👀",
  "{name} ka naya message aaya hai 💬",
  "Ek naya message {name} ki taraf se ✨",
  "📩 {name} se message aaya hai",
  "{name} soch rahe the tumhare baare mein... ya bas message hi bheja 😄",
  "{name} ki taraf se ek surprise 🎁",
  "Tumhara phone abhi hila — {name} ne likha hai kuch",
  "{name}: naya message wait kar raha hai 👋"
];
function creativeNotifyBody(senderName) {
  const t = NOTIFY_TEMPLATES[Math.floor(Math.random() * NOTIFY_TEMPLATES.length)];
  return t.replace('{name}', senderName);
}

async function sendPushTo(who, payload) {
  const data = loadData();
  const subs = loadPushSubs(data);
  const sub = subs[who];
  if (!sub) return;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      // subscription is dead (uninstalled, permission revoked, etc.) — drop it
      await withLock(() => {
        const d = loadData();
        const s = loadPushSubs(d);
        delete s[who];
        d[PUSH_SUB_KEY] = JSON.stringify(s);
        saveData(d);
      });
    } else {
      console.error('push send failed:', e.message);
    }
  }
}

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_KEYS.publicKey });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { who, subscription } = req.body || {};
  if (!who || !subscription) return res.status(400).json({ error: 'who and subscription required' });
  try {
    await withLock(() => {
      const data = loadData();
      const subs = loadPushSubs(data);
      subs[who] = subscription;
      data[PUSH_SUB_KEY] = JSON.stringify(subs);
      saveData(data);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'save failed' });
  }
});

// ---------- Generic key/value (kept for typing status etc.) ----------
app.get('/api/data', (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'key required' });
  const data = loadData();
  res.json({ value: data[key] || null });
});

app.post('/api/data', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    await withLock(() => {
      const data = loadData();
      data[key] = value;
      saveData(data);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'save failed' });
  }
});

// ---------- Messages (atomic, race-free) ----------
const MSG_KEY = 'us-chat-messages';

function getMessages(data) {
  if (!data[MSG_KEY]) return [];
  try {
    return JSON.parse(data[MSG_KEY]);
  } catch (e) {
    return [];
  }
}

// Full list (used for initial load / poll)
app.get('/api/messages', (req, res) => {
  const data = loadData();
  res.json({ messages: getMessages(data) });
});

// Append exactly one message, atomically
app.post('/api/messages', async (req, res) => {
  const msg = req.body && req.body.message;
  if (!msg || !msg.id) return res.status(400).json({ error: 'message required' });
  try {
    let wasNew = false;
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      // idempotency guard: if this id already exists (e.g. a retried
      // request after a flaky connection), don't push it twice
      if (!list.some(m => m.id === msg.id)) {
        list.push(msg);
        data[MSG_KEY] = JSON.stringify(list);
        saveData(data);
        wasNew = true;
      }
      return list;
    });
    if (wasNew) {
      // fire-and-forget: notify the OTHER person, never the sender's own name
      const other = Object.keys(MEMBERS).find(n => n !== msg.from);
      const senderName = (MEMBERS[msg.from] || {}).name || 'Someone';
      if (other) {
        sendPushTo(other, {
          title: senderName,
          body: creativeNotifyBody(senderName),
          tag: 'jeeru-message'
        });
      }
    }
    res.json({ ok: true, messages });
  } catch (e) {
    res.status(500).json({ error: 'save failed' });
  }
});

// Mark all of `from`'s messages as seen, atomically
app.post('/api/messages/seen', async (req, res) => {
  const { from } = req.body || {};
  if (!from) return res.status(400).json({ error: 'from required' });
  try {
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      let changed = false;
      list.forEach(m => { if (m.from === from && !m.seen) { m.seen = true; changed = true; } });
      if (changed) {
        data[MSG_KEY] = JSON.stringify(list);
        saveData(data);
      }
      return list;
    });
    res.json({ ok: true, messages });
  } catch (e) {
    res.status(500).json({ error: 'save failed' });
  }
});

// Toggle a reaction on one message, atomically
app.post('/api/messages/react', async (req, res) => {
  const { id, who, emoji } = req.body || {};
  if (!id || !who) return res.status(400).json({ error: 'id and who required' });
  try {
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      const target = list.find(m => m.id === id);
      if (target) {
        target.reactions = target.reactions || {};
        if (target.reactions[who] === emoji) delete target.reactions[who];
        else target.reactions[who] = emoji;
        data[MSG_KEY] = JSON.stringify(list);
        saveData(data);
      }
      return list;
    });
    res.json({ ok: true, messages });
  } catch (e) {
    res.status(500).json({ error: 'save failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Jeeru server running on port ' + PORT));
