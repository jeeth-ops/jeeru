const express = require('express');
const fs = require('fs');
const path = require('path');

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
    const messages = await withLock(() => {
      const data = loadData();
      const list = getMessages(data);
      // idempotency guard: if this id already exists (e.g. a retried
      // request after a flaky connection), don't push it twice
      if (!list.some(m => m.id === msg.id)) {
        list.push(msg);
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
