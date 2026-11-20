'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePlaylistId, fetchPlaylistVideos, fetchVideoInfo } = require('../lib/youtube');

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('parsePlaylistId reads list= from YouTube URLs only', () => {
  const list = 'PLabcdefghijKLMNOP';
  assert.equal(parsePlaylistId(`https://www.youtube.com/playlist?list=${list}`), list);
  assert.equal(parsePlaylistId(`https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=${list}`), list);
  assert.equal(parsePlaylistId('https://evil.example.com/playlist?list=PLabcdefghijKLMNOP'), null);
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=bad!'), null);
  assert.equal(parsePlaylistId('not a url'), null);
});

test('fetchPlaylistVideos follows pages and skips unusable items', async () => {
  const pages = [
    {
      items: [
        { snippet: { title: 'One', resourceId: { videoId: 'aaaaaaaaaaa' } } },
        { snippet: { title: 'Broken', resourceId: { videoId: 'not valid' } } },
      ],
      nextPageToken: 'page2',
    },
    {
      items: [{ snippet: { title: '  Two\n', resourceId: { videoId: 'bbbbbbbbbbb' } } }],
    },
  ];
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    return json(pages[seen.length - 1]);
  };
  const videos = await fetchPlaylistVideos('PLx1234567890', 'KEY', { fetchImpl: fakeFetch });
  assert.deepEqual(videos, [
    { videoId: 'aaaaaaaaaaa', title: 'One' },
    { videoId: 'bbbbbbbbbbb', title: 'Two' },
  ]);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /pageToken=page2/);
});

test('fetchPlaylistVideos respects maxItems and gives safe error messages', async () => {
  const big = { items: Array.from({ length: 50 }, (_, i) => ({ snippet: { title: `t${i}`, resourceId: { videoId: `vid${String(i).padStart(8, '0')}` } } })), nextPageToken: 'more' };
  const videos = await fetchPlaylistVideos('PLx1234567890', 'KEY', { fetchImpl: async () => json(big), maxItems: 10 });
  assert.equal(videos.length, 10);

  await assert.rejects(
    fetchPlaylistVideos('PLx1234567890', 'SECRETKEY', { fetchImpl: async () => json({}, 404) }),
    (err) => /isn't public/.test(err.message) && !err.message.includes('SECRETKEY'),
  );
  await assert.rejects(
    fetchPlaylistVideos('PLx1234567890', 'KEY', { fetchImpl: async () => { throw new Error('offline'); } }),
    /could not be reached/,
  );
});

test('fetchVideoInfo rejects missing videos and falls back on network errors', async () => {
  const missing = await fetchVideoInfo('zzzzzzzzzzz', async () => json({}, 404));
  assert.equal(missing.ok, false);

  const offline = await fetchVideoInfo('yyyyyyyyyyy', async () => { throw new Error('offline'); });
  assert.equal(offline.ok, true);
  assert.equal(offline.title, 'Video yyyyyyyyyyy');

  const titled = await fetchVideoInfo('xxxxxxxxxxx', async () => json({ title: 'Real title' }));
  assert.deepEqual(titled, { ok: true, title: 'Real title' });
});
