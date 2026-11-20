// Static (GitHub Pages) transport for TogetherMix.
//
// There is no server. The browser that created a room is its host: it runs the
// same room rules (lib/room.js) and the same event handlers (lib/sockets.js)
// as the Node server, and keeps the room in its own localStorage. Friends
// connect to the host directly over WebRTC; Trystero finds peers through free
// public Nostr relays, so nobody needs an account, key or server.
//
// window.io() returns an object with the small part of the socket.io client API
// that public/js/room.js uses, so the room page code is shared with the server
// version unchanged.

import { joinRoom } from 'trystero';
import rooms from '../../lib/room.js';
import sockets from '../../lib/sockets.js';

const APP_ID = 'togethermix.aurakingstudio.github.io';
const KEY_ROOM = (id) => `tm.room.${id}`;
const RPC_TIMEOUT_MS = 10000;
const WAITING_HINT_MS = 7000;

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: room lasts this session */ }
  },
};

function randomToken(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % 64];
  return out;
}

// Small keyed hash so member IDs are never sent to other people (same idea as
// the server's HMAC tag). Synchronous because lib/sockets.js calls it inline.
function tagger(secret) {
  return (memberId) => {
    const text = `${secret}:${memberId}`;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  };
}

// Titles: YouTube's own oEmbed endpoint blocks browser requests, so use
// noembed.com (free, no key). If it is unreachable, the add still works.
async function resolveTitle(videoId) {
  const fallback = { ok: true, title: `Video ${videoId}` };
  try {
    const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(`https://noembed.com/embed?url=${target}`);
    if (!res.ok) return fallback;
    const data = await res.json();
    if (typeof data.title === 'string' && data.title.trim()) {
      return { ok: true, title: data.title.replace(/\s+/g, ' ').trim().slice(0, 200) };
    }
    if (data.error && /404|not found/i.test(String(data.error))) return { ok: false };
    return fallback;
  } catch {
    return fallback;
  }
}

// ---- room creation (home page) ------------------------------------------------

function createLocalRoom({ name, settings, memberId }) {
  const id = rooms.newRoomId();
  const room = rooms.createRoom({
    id,
    name: rooms.cleanRoomName(name),
    settings: rooms.sanitizeSettings(settings),
    hostMemberId: memberId,
    hostTokenHash: '',
    now: Date.now(),
  });
  const hostToken = randomToken(32);
  storage.set(KEY_ROOM(id), JSON.stringify({
    room: rooms.serializeRoom(room),
    hostToken,
    tagSecret: randomToken(32),
  }));
  return { id, hostToken };
}

// ---- in-page stand-in for the socket.io server ----------------------------------

class Emitter {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }
  fire(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(...args);
  }
}

class ServerSocket extends Emitter {
  constructor(id, hub, push) {
    super();
    this.id = id;
    this.hub = hub;
    this.push = push; // (event, data) => deliver to this client
  }
  join(roomId) { this.hub.member(roomId).add(this); }
  leave(roomId) { this.hub.member(roomId).delete(this); }
  // Runs a client event through the registered handler and resolves with its ack.
  dispatch(event, payload) {
    return new Promise((resolve) => {
      const fns = this.handlers.get(event) || [];
      if (!fns.length) return resolve({ ok: false, error: 'Unknown request.' });
      fns[0](payload ?? {}, resolve);
    });
  }
}

class Hub extends Emitter {
  constructor() {
    super();
    this.groups = new Map();
  }
  member(roomId) {
    if (!this.groups.has(roomId)) this.groups.set(roomId, new Set());
    return this.groups.get(roomId);
  }
  to(roomId) {
    return { emit: (event, data) => { for (const s of this.member(roomId)) s.push(event, data); } };
  }
  connect(id, push) {
    const socket = new ServerSocket(id, this, push);
    this.fire('connection', socket);
    return socket;
  }
}

function startHost(roomId, record) {
  const room = rooms.restoreRoom(record.room);
  let saveTimer = null;
  const store = {
    get: (id) => (id === roomId ? room : undefined),
    ownerTag: tagger(record.tagSecret),
    verifyHost: (r, token) => typeof token === 'string' && token === record.hostToken,
    markDirty() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        record.room = rooms.serializeRoom(room);
        storage.set(KEY_ROOM(roomId), JSON.stringify(record));
      }, 500);
    },
  };
  const hub = new Hub();
  sockets.registerSockets(hub, { store, resolveTitle, youtubeApiKey: '', now: Date.now });
  return hub;
}

// ---- client sockets ---------------------------------------------------------------

class ClientSocket extends Emitter {
  constructor(call) {
    super();
    this.call = call; // (event, payload, timeoutMs) => Promise<ack>
  }
  timeout(ms) {
    return { emitWithAck: (event, payload) => this.call(event, payload, ms) };
  }
  emit(event, payload) {
    this.call(event, payload, RPC_TIMEOUT_MS).catch(() => {});
  }
  disconnect() { this.fire('closed'); }
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('operation has timed out')), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

function setWaitingStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function io() {
  const roomMatch = location.hash.match(/^#([a-z0-9]{10})$/i);
  const roomId = roomMatch ? roomMatch[1].toLowerCase() : '';
  const raw = storage.get(KEY_ROOM(roomId));
  const record = raw ? JSON.parse(raw) : null;

  const p2p = joinRoom({ appId: APP_ID, password: roomId }, `room-${roomId}`);
  const hello = p2p.makeAction('hello');
  const rpc = p2p.makeAction('rpc', { kind: 'request' });
  const push = p2p.makeAction('push');

  if (record) {
    // This browser created the room: run it here and serve everyone else.
    const hub = startHost(roomId, record);
    let local = null;
    const client = new ClientSocket((event, payload, ms) => withTimeout(local.dispatch(event, payload), ms));
    local = hub.connect('local', (event, data) => client.fire(event, data));

    const remotes = new Map(); // peerId -> ServerSocket
    const remoteFor = (peerId) => {
      if (!remotes.has(peerId)) {
        remotes.set(peerId, hub.connect(`peer:${peerId}`, (event, data) => {
          push.send({ event, data }, { target: peerId }).catch(() => {});
        }));
      }
      return remotes.get(peerId);
    };
    rpc.onRequest(({ event, payload } = {}, { peerId }) => {
      // A guest can never act as host: the host token only exists in this browser.
      if (payload && typeof payload === 'object') delete payload.hostToken;
      return remoteFor(peerId).dispatch(String(event), payload);
    });
    p2p.onPeerJoin(({ peerId }) => { hello.send({ roomId }, { target: peerId }).catch(() => {}); });
    p2p.onPeerLeave(({ peerId }) => {
      const socket = remotes.get(peerId);
      remotes.delete(peerId);
      if (socket) socket.fire('disconnect');
    });
    setTimeout(() => client.fire('connect'), 0);
    return client;
  }

  // Guest: wait for the host to say hello, then send every request to it.
  let hostPeer = null;
  const client = new ClientSocket((event, payload, ms) => {
    if (!hostPeer) return Promise.reject(new Error('The host is not connected.'));
    return rpc.request({ event, payload: payload ?? null }, { target: hostPeer, timeoutMs: ms });
  });
  hello.onMessage((data, { peerId }) => {
    if (hostPeer || !data || data.roomId !== roomId) return;
    hostPeer = peerId;
    client.fire('connect');
  });
  push.onMessage((msg, { peerId }) => {
    if (peerId === hostPeer && msg && typeof msg.event === 'string') client.fire(msg.event, msg.data);
  });
  p2p.onPeerLeave(({ peerId }) => {
    if (peerId !== hostPeer) return;
    hostPeer = null;
    client.fire('disconnect');
    setWaitingStatus('Waiting for the host…');
  });
  setTimeout(() => {
    if (!hostPeer) setWaitingStatus('Waiting for the host to open the room…');
  }, WAITING_HINT_MS);
  return client;
}

window.io = io;
window.TMP2P = { createLocalRoom };
