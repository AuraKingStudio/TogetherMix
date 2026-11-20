'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./lib/config');
const rooms = require('./lib/room');
const { RoomStore } = require('./lib/store');
const { fetchVideoInfo } = require('./lib/youtube');
const { registerSockets } = require('./lib/sockets');
const { createKeyedLimiter } = require('./lib/rate-limit');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOUR_MS = 3_600_000;

const store = new RoomStore({ file: config.dataFile, idleDays: config.roomIdleDays });
store.load();

const createLimiter = createKeyedLimiter({ max: 10, windowMs: HOUR_MS });

const app = express();
app.disable('x-powered-by');
if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  next();
});
app.use(express.json({ limit: '4kb' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// Public settings the browser needs (AdSense IDs are public by design).
app.get('/config.js', (req, res) => {
  const payload = {
    siteName: config.siteName,
    adsenseClient: config.adsenseClient,
    adsenseSlot: config.adsenseSlot,
  };
  res
    .type('application/javascript')
    .set('Cache-Control', 'no-cache')
    .send(`window.TOGETHERMIX_CONFIG = ${JSON.stringify(payload).replace(/</g, '\\u003c')};`);
});

// Required by Google AdSense to authorise this site's ad seller.
app.get('/ads.txt', (req, res) => {
  res.type('text/plain');
  if (!config.adsensePublisher) return res.status(404).send('');
  res.send(`google.com, ${config.adsensePublisher}, DIRECT, f08c47fec0942fa0\n`);
});

app.post(
  '/api/rooms',
  (req, res, next) => {
    if (!createLimiter.allow(req.ip)) {
      return res.status(429).json({ error: 'Too many rooms created from here. Try again later.' });
    }
    next();
  },
  (req, res) => {
    try {
      const { name, memberId, settings } = req.body || {};
      if (!rooms.isValidMemberId(memberId)) {
        return res.status(400).json({ error: 'Invalid session. Reload the page.' });
      }
      const { room, hostToken } = store.create({ name, settings, memberId });
      return res.status(201).json({ id: room.id, hostToken });
    } catch (err) {
      if (err instanceof rooms.RoomError) return res.status(400).json({ error: err.message });
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  },
);

// Room pages are the same HTML for every room; the page reads the ID from the URL.
app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'room.html'));
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

// Malformed JSON and similar client errors.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status < 500 ? 400 : 500).json({ error: status < 500 ? 'Bad request.' : 'Something went wrong.' });
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});
registerSockets(io, {
  store,
  resolveTitle: fetchVideoInfo,
  youtubeApiKey: config.youtubeApiKey,
});

const sweeper = setInterval(() => store.sweep(), HOUR_MS);
sweeper.unref();

server.listen(config.port, config.host, () => {
  console.log(`${config.siteName} listening on http://${config.host}:${config.port}`);
});

function shutdown() {
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
