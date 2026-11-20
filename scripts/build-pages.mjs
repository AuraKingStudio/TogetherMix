// Builds the static (GitHub Pages) version of TogetherMix into site/:
//   site/index.html  one self-contained page: home, room (#<roomId>) and privacy (#privacy)
//   site/ads.txt     AdSense seller file (only when a publisher ID is set)
//
// The page markup, styles and room code come from public/ and lib/, so the
// server version and the static version stay the same app.
//
// Usage: node scripts/build-pages.mjs
// Optional env: ADSENSE_CLIENT (defaults to this site's publisher ID), ADSENSE_SLOT.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

const adsenseClient = process.env.ADSENSE_CLIENT || 'ca-pub-9025370057489197';
const adsenseSlot = process.env.ADSENSE_SLOT || '';
if (!/^ca-pub-\d{10,20}$/.test(adsenseClient)) throw new Error('ADSENSE_CLIENT must look like ca-pub-1234567890123456');
if (adsenseSlot && !/^\d{6,20}$/.test(adsenseSlot)) throw new Error('ADSENSE_SLOT must be the numeric ad unit ID');

// Bundle the P2P transport with the shared room rules (lib/room.js, lib/sockets.js).
const bundle = await build({
  entryPoints: [path.join(root, 'pages/js/p2p.js')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  plugins: [{
    name: 'browser-crypto',
    setup(b) {
      b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: path.join(root, 'pages/shims/crypto.js') }));
    },
  }],
});
const p2pJs = bundle.outputFiles[0].text;

// Takes the markup between <body> and the first <script> of a page.
function bodyOf(html) {
  const start = html.indexOf('>', html.indexOf('<body')) + 1;
  const end = html.indexOf('<script', start);
  return html.slice(start, end === -1 ? html.indexOf('</body>') : end).trim();
}
const fixLinks = (html) => html
  .replace(/href="\/privacy\.html"/g, 'href="#privacy"')
  .replace(/href="\/"/g, 'href="./"')
  .replace(/https:\/\/…\/r\/abcdefghjk/g, 'https://…/#abcdefghjk');

const [indexHtml, roomHtml, privacyHtml, css, commonJs, roomJs, homeJs, partyJs] = await Promise.all([
  read('public/index.html'),
  read('public/room.html'),
  read('public/privacy.html'),
  read('public/css/style.css'),
  read('public/js/common.js'),
  read('public/js/room.js'),
  read('pages/js/home.js'),
  read('public/js/party.js'),
]);

const config = {
  siteName: 'TogetherMix',
  adsenseClient,
  adsenseSlot,
  staticSite: true,
};

// Inline scripts must not contain a closing script tag.
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TogetherMix · Listen to your friends' mixes, together</title>
  <meta name="description" content="Create a room, share the invite link, and build one shared pool of YouTube music mixes. Everyone watches and listens in sync.">
  <meta name="google-adsense-account" content="${adsenseClient}">
  <style>
${css}
  </style>
</head>
<body>
  <template id="tpl-home">
${fixLinks(bodyOf(indexHtml))}
  </template>
  <template id="tpl-room">
${fixLinks(bodyOf(roomHtml))}
  </template>
  <template id="tpl-privacy">
${fixLinks(bodyOf(privacyHtml))}
  </template>

  <script>window.TOGETHERMIX_CONFIG = ${JSON.stringify(config)};</script>
  <script>
${safe(commonJs)}
  </script>
  <script>
${safe(p2pJs)}
  </script>
  <script>
${safe(partyJs)}
  </script>
  <script>
${safe(homeJs)}
function startRoom() {
${safe(roomJs)}
}
  </script>
  <script>
(() => {
  'use strict';
  const key = location.hash.slice(1);
  const mode = /^[a-z0-9]{10}$/i.test(key) ? 'room' : key === 'privacy' ? 'privacy' : 'home';
  const bodyClass = { home: 'home', room: 'room-page', privacy: 'doc-page' };
  document.body.className = bodyClass[mode];
  document.body.prepend(document.getElementById('tpl-' + mode).content.cloneNode(true));
  if (mode === 'room') {
    document.title = 'Room · TogetherMix';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
    startRoom();
  } else if (mode === 'home') {
    startHome();
  } else {
    document.title = 'Privacy · TogetherMix';
  }
  // Each view is built once at load, so switching views reloads the page.
  addEventListener('hashchange', () => location.reload());
})();
  </script>
</body>
</html>
`;

await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'index.html'), page);
await writeFile(path.join(out, '.nojekyll'), '');
await writeFile(path.join(out, 'ads.txt'), `google.com, ${adsenseClient.replace(/^ca-/, '')}, DIRECT, f08c47fec0942fa0\n`);
console.log(`Built site/index.html (${Math.round(page.length / 1024)} KB) and site/ads.txt`);
