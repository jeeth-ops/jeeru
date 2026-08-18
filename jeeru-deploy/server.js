const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by'); // don't advertise Express/version to the internet
app.use(express.json({ limit: '25mb' }));

// ---------- Baseline security headers on every response ----------
// (No helmet dependency — this is a small, fixed set of headers, so a
// couple of lines here avoids pulling in an extra package.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');           // no embedding Jeeru in someone else's iframe
  res.setHeader('Referrer-Policy', 'no-referrer');     // never leak URLs (with keys/ids) to a third-party Referer header
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), interest-cohort=()');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});
// Chat content is private — make sure nothing in /api ever gets cached by a
// shared proxy, a browser back/forward cache, or written to disk anywhere.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  // Never let the static server hand out dotfiles (.env, .git, etc.)
  dotfiles: 'deny',
  index: ['index.html']
}));

const DATA_FILE = path.join(__dirname, 'data.json');

// Defense in depth: data.json / server.js / package*.json live outside the
// `public/` folder that express.static serves, so they are already
// unreachable over HTTP — but block them by name explicitly too, in case
// the static root is ever pointed at the project root by mistake later.
app.use((req, res, next) => {
  if (/^\/(data\.json|server\.js|package(-lock)?\.json|\.env)$/i.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

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
    // Routed through withLock (same as everything else that touches
    // data.json) so a fast poller writing e.g. room/playback state can't
    // race a concurrent write and clobber it.
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

// ---------- Generic atomic list factory ----------
// Powers Moments / Memories / Surprises / Gifts. Same read-modify-write-race
// protection as messages above: every mutation goes through withLock so two
// simultaneous requests can never silently clobber each other.
function registerListRoutes(route, storageKey){
  function getList(data){
    if(!data[storageKey]) return [];
    try{ return JSON.parse(data[storageKey]); }catch(e){ return []; }
  }
  function setList(data, list){ data[storageKey] = JSON.stringify(list); saveData(data); }

  app.get('/api/' + route, async (req, res) => {
    try{
      const list = await withLock(() => getList(loadData()));
      res.json({ items: list });
    }catch(e){ res.status(500).json({ error: 'load failed' }); }
  });

  app.post('/api/' + route, async (req, res) => {
    const item = req.body && req.body.item;
    if(!item || !item.id) return res.status(400).json({ error: 'item required' });
    try{
      const list = await withLock(() => {
        const data = loadData();
        const l = getList(data);
        if(!l.some(x => x.id === item.id)) l.push(item);
        setList(data, l);
        return l;
      });
      res.json({ ok:true, items:list });
    }catch(e){ res.status(500).json({ error: 'save failed' }); }
  });

  app.post('/api/' + route + '/react', async (req, res) => {
    const { id, who, emoji } = req.body || {};
    if(!id || !who) return res.status(400).json({ error:'id and who required' });
    try{
      const list = await withLock(() => {
        const data = loadData();
        const l = getList(data);
        const t = l.find(x => x.id === id);
        if(t){
          t.reactions = t.reactions || {};
          if(t.reactions[who] === emoji) delete t.reactions[who];
          else t.reactions[who] = emoji;
          setList(data, l);
        }
        return l;
      });
      res.json({ ok:true, items:list });
    }catch(e){ res.status(500).json({ error:'save failed' }); }
  });

  app.post('/api/' + route + '/comment', async (req, res) => {
    const { id, from, text } = req.body || {};
    if(!id || !from || !text) return res.status(400).json({ error:'id, from, text required' });
    try{
      const list = await withLock(() => {
        const data = loadData();
        const l = getList(data);
        const t = l.find(x => x.id === id);
        if(t){
          t.comments = t.comments || [];
          t.comments.push({ id: crypto.randomBytes(6).toString('hex'), from, text, createdAt: Date.now() });
          setList(data, l);
        }
        return l;
      });
      res.json({ ok:true, items:list });
    }catch(e){ res.status(500).json({ error:'save failed' }); }
  });

  app.post('/api/' + route + '/save', async (req, res) => {
    const { id, who } = req.body || {};
    if(!id || !who) return res.status(400).json({ error:'id and who required' });
    try{
      const list = await withLock(() => {
        const data = loadData();
        const l = getList(data);
        const t = l.find(x => x.id === id);
        if(t){
          t.saved = t.saved || {};
          if(t.saved[who]) delete t.saved[who]; else t.saved[who] = true;
          setList(data, l);
        }
        return l;
      });
      res.json({ ok:true, items:list });
    }catch(e){ res.status(500).json({ error:'save failed' }); }
  });

  // Generic field patch — used for e.g. marking a surprise/gift opened,
  // or converting a moment into a memory (sets memoryId on the moment).
  app.post('/api/' + route + '/update', async (req, res) => {
    const { id, patch } = req.body || {};
    if(!id || !patch || typeof patch !== 'object') return res.status(400).json({ error:'id and patch required' });
    try{
      const list = await withLock(() => {
        const data = loadData();
        const l = getList(data);
        const t = l.find(x => x.id === id);
        if(t){
          Object.assign(t, patch);
          setList(data, l);
        }
        return l;
      });
      res.json({ ok:true, items:list });
    }catch(e){ res.status(500).json({ error:'save failed' }); }
  });

  app.post('/api/' + route + '/delete', async (req, res) => {
    const { id, who } = req.body || {};
    if(!id || !who) return res.status(400).json({ error:'id and who required' });
    try{
      const list = await withLock(() => {
        const data = loadData();
        let l = getList(data);
        const t = l.find(x => x.id === id);
        // only the author can delete their own post — same 2-person trust
        // model as the rest of the app, just guarding against accidents
        if(t && t.from === who){
          l = l.filter(x => x.id !== id);
          setList(data, l);
        }
        return l;
      });
      res.json({ ok:true, items:list });
    }catch(e){ res.status(500).json({ error:'save failed' }); }
  });
}

registerListRoutes('moments', 'us-moments');
registerListRoutes('memories', 'us-memories');
registerListRoutes('surprises', 'us-surprises');
registerListRoutes('gifts', 'us-gifts');
// CALENDAR: shared events (anniversaries, birthdays, trips, reminders).
// /update is used to edit a field (e.g. reminderSent) or check off a reminder.
registerListRoutes('calendar', 'us-calendar');
// JOURNAL: shared private diary entries (text/photo/video/voice/mood/date/location).
registerListRoutes('journal', 'us-journal');
// OUR PLACES: meaningful couple locations (first date, favourites, trips, milestones).
// Each item: { id, from, title, category, date, notes, photos:[dataURL...], createdAt }
registerListRoutes('places', 'us-places');

// ---------- Listen Together / Watch Together: synchronized rooms ----------
// One small room-state object per room type ("listen" or "watch"), holding
// current source, play/pause/seek position, and both members' presence.
// Reused the same withLock + data.json pattern as everything above, so a
// rapid stream of position updates from two devices never race each other.
// Floating reactions and in-room chat are appended into short ring buffers
// inside the room state (capped) rather than the main message list, since
// they're ephemeral/high-frequency and shouldn't bloat data.json forever.
const ROOM_TYPES = ['listen', 'watch'];
const ROOM_EVENT_CAP = 60; // keep only the most recent N reactions/chat lines per room

function roomKey(type) { return 'us-room-' + type; }

function defaultRoom() {
  return {
    source: null,        // { kind:'audio'|'video', url, title }
    isPlaying: false,
    position: 0,          // seconds
    updatedAt: 0,          // server timestamp the position was last true at
    updatedBy: null,
    presence: {},          // { [who]: lastSeenTs }
    events: []             // [{ id, type:'reaction'|'chat', from, payload, ts }]
  };
}

function getRoom(data, type) {
  const raw = data[roomKey(type)];
  if (!raw) return defaultRoom();
  try {
    const r = JSON.parse(raw);
    return Object.assign(defaultRoom(), r);
  } catch (e) {
    return defaultRoom();
  }
}

function setRoom(data, type, room) {
  data[roomKey(type)] = JSON.stringify(room);
  saveData(data);
}

ROOM_TYPES.forEach((type) => {
  // Full room state (source, playback, presence, recent events)
  app.get('/api/room/' + type, async (req, res) => {
    try {
      const room = await withLock(() => {
        const data = loadData();
        const r = getRoom(data, type);
        // presence older than 20s is considered "left"
        const now = Date.now();
        Object.keys(r.presence).forEach((who) => {
          if (now - r.presence[who] > 20000) delete r.presence[who];
        });
        return r;
      });
      res.json({ room });
    } catch (e) {
      res.status(500).json({ error: 'load failed' });
    }
  });

  // Patch playback/source state and/or send a presence heartbeat, atomically.
  // Body: { patch?: {source, isPlaying, position}, who?: 'me' }
  app.post('/api/room/' + type, async (req, res) => {
    const { patch, who } = req.body || {};
    try {
      const room = await withLock(() => {
        const data = loadData();
        const r = getRoom(data, type);
        if (patch && typeof patch === 'object') {
          if ('source' in patch) r.source = patch.source;
          if ('isPlaying' in patch) r.isPlaying = !!patch.isPlaying;
          if ('position' in patch) r.position = Number(patch.position) || 0;
          r.updatedAt = Date.now();
          r.updatedBy = who || null;
        }
        if (who) r.presence[who] = Date.now();
        setRoom(data, type, r);
        return r;
      });
      res.json({ ok: true, room });
    } catch (e) {
      res.status(500).json({ error: 'save failed' });
    }
  });

  // Append a transient event (floating reaction emoji, or in-room chat line)
  app.post('/api/room/' + type + '/event', async (req, res) => {
    const { eventType, from, payload } = req.body || {};
    if (!eventType || !from) return res.status(400).json({ error: 'eventType and from required' });
    try {
      const room = await withLock(() => {
        const data = loadData();
        const r = getRoom(data, type);
        r.events.push({ id: crypto.randomBytes(6).toString('hex'), type: eventType, from, payload: payload || null, ts: Date.now() });
        if (r.events.length > ROOM_EVENT_CAP) r.events = r.events.slice(-ROOM_EVENT_CAP);
        setRoom(data, type, r);
        return r;
      });
      res.json({ ok: true, room });
    } catch (e) {
      res.status(500).json({ error: 'save failed' });
    }
  });

  // Leave the room: drop presence immediately instead of waiting on the 20s timeout
  app.post('/api/room/' + type + '/leave', async (req, res) => {
    const { who } = req.body || {};
    if (!who) return res.status(400).json({ error: 'who required' });
    try {
      const room = await withLock(() => {
        const data = loadData();
        const r = getRoom(data, type);
        delete r.presence[who];
        setRoom(data, type, r);
        return r;
      });
      res.json({ ok: true, room });
    } catch (e) {
      res.status(500).json({ error: 'save failed' });
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Jeeru server running on port ' + PORT));
