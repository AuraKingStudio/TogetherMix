'use strict';

const path = require('node:path');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const adsenseClient = env('ADSENSE_CLIENT', '');
const adsenseSlot = env('ADSENSE_SLOT', '');

if (adsenseClient && !/^ca-pub-\d{10,20}$/.test(adsenseClient)) {
  throw new Error('ADSENSE_CLIENT must look like ca-pub-1234567890123456');
}
if (adsenseSlot && !/^\d{6,20}$/.test(adsenseSlot)) {
  throw new Error('ADSENSE_SLOT must be the numeric ad unit ID from AdSense');
}

module.exports = Object.freeze({
  port: Number(env('PORT', 3000)),
  host: env('HOST', '0.0.0.0'),
  siteName: env('SITE_NAME', 'TogetherMix'),
  dataFile: path.resolve(env('DATA_FILE', path.join(__dirname, '..', 'data', 'rooms.json'))),
  // Number of reverse proxies in front of the app (0 = connect directly).
  trustProxy: Number(env('TRUST_PROXY', 0)),
  roomIdleDays: Number(env('ROOM_IDLE_DAYS', 30)),
  // Optional. Enables importing whole public playlists (YouTube Data API v3 key).
  youtubeApiKey: env('YOUTUBE_API_KEY', ''),
  adsenseClient,
  adsenseSlot,
  // ads.txt needs the publisher part without the "ca-" prefix.
  adsensePublisher: adsenseClient ? adsenseClient.replace(/^ca-/, 'pub-') : '',
});
