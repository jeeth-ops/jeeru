const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data.json');

/**
 * ---------- Shared-secret access gate ----------
 * JEERU_KEY is a passphrase only the two of you know. It must be set as an
 * environment variable on Render (Dashboard -> your service -> Environment),
 * NEVER written into this file or committed to git. Without it set, the
 * server refuses to serve any API request — safer default than an open API.
 */
const JEERU_KEY = process.env.JEERU_KEY || '';
if (!JEERU_KEY) {
  console.warn('WARNING: JEERU_KEY env var is not set. All API requests will be rejected until it is.');
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  // Pad to equal length before comparing, so the comparison itself never
  // leaks the real key's length via timing.
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.concat([bufA], len);
  const padB = Buffer.concat([bufB], len);
  return bufA.length === bufB.length && crypto.timingSafeEqual(padA, padB);
}

// ---- Basic brute-force protection on login attempts, per IP ----
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function isRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (entry) entry.count += 1;
}

// ---- Login: exchange the shared passphrase for confirmation ----
// (The passphrase itself, not a token, is what's sent as the key on every
// later request — simple and fine for a 2-person app, since it always
// travels over HTTPS on Render and is never logged.)
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const { pin } = req.body || {};
  if (!JEERU_KEY || !timingSafeStringEqual(pin, JEERU_KEY)) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'invalid pin' });
  }
  res.json({ ok: true });
});

// ---- Everything under /api (except /api/login above) requires the key ----
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  const key = req.headers['x-jeeru-key'];
  if (!JEERU_KEY || !timingSafeStringEqual(key, JEERU_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

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

// Disappearing messages: a message can carry an `expiresAt` timestamp (ms).
// Every time the list is read we drop anything past its expiry and persist
// that removal, atomically, so "disappearing" actually deletes the message
// from data.json rather than just hiding it on one device.
function purgeExpired(list){
  const now = Date.now();
  let changed = false;
  const kept = list.filter(m => {
    if (m.expiresAt && m.expiresAt <= now) { changed = true; return false; }
    return true;
  });
  return { kept, changed };
}

// Full list (used for initial load / poll)
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      const { kept, changed } = purgeExpired(list);
      if (changed) {
        data[MSG_KEY] = JSON.stringify(kept);
        saveData(data);
      }
      return kept;
    });
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: 'load failed' });
  }
});

// Append exactly one message, atomically
app.post('/api/messages', async (req, res) => {
  const msg = req.body && req.body.message;
  if (!msg || !msg.id) return res.status(400).json({ error: 'message required' });
  try {
    const messages = await withLock(() => {
      const data = loadData();
      let list = getMessages(data);
      list = purgeExpired(list).kept;
      // idempotency guard: if this id already exists (e.g. a retried
      // request after a flaky connection), don't push it twice
      if (!list.some(m => m.id === msg.id)) {
        list.push(msg);
      }
      data[MSG_KEY] = JSON.stringify(list);
      saveData(data);
      return list;
    });
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

// Toggle pin on a message. Only one message can be pinned at a time (this is
// a 2-person chat), so pinning a new message automatically unpins whatever
// was pinned before — atomic, same pattern as /react above.
app.post('/api/messages/pin', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      const target = list.find(m => m.id === id);
      if (target) {
        const wasPinned = !!target.pinned;
        list.forEach(m => { delete m.pinned; });
        if (!wasPinned) target.pinned = true;
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

// Toggle a star (personal favorite) on a message for one user, atomically
app.post('/api/messages/star', async (req, res) => {
  const { id, who } = req.body || {};
  if (!id || !who) return res.status(400).json({ error: 'id and who required' });
  try {
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      const target = list.find(m => m.id === id);
      if (target) {
        target.stars = target.stars || {};
        if (target.stars[who]) delete target.stars[who];
        else target.stars[who] = true;
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
