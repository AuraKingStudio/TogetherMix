'use strict';

// Only YouTube video IDs are accepted. Videos are played through the official
// IFrame player; nothing is downloaded or re-hosted.

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);
const REJECT_STATUSES = new Set([400, 401, 403, 404]);
const TITLE_CACHE_MAX = 5000;
const titleCache = new Map();

function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (VIDEO_ID_RE.test(text)) return text;

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] || null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const match = url.pathname.match(/^\/(shorts|embed|live)\/([^/]+)/);
    if (match) id = match[2];
  }
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Resolves a display title with YouTube's public oEmbed endpoint (no API key).
// Returns { ok: false } only when YouTube says the video is missing or not embeddable.
// Network trouble falls back to a placeholder title so adds still work.
async function fetchVideoInfo(videoId, fetchImpl = globalThis.fetch) {
  const cached = titleCache.get(videoId);
  if (cached) return { ok: true, title: cached };

  const fallback = `Video ${videoId}`;
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`;

  try {
    const res = await fetchImpl(endpoint, {
      headers: { accept: 'application/json', 'user-agent': 'TogetherMix/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (REJECT_STATUSES.has(res.status)) return { ok: false };
    if (!res.ok) return { ok: true, title: fallback };

    const data = await res.json();
    const title = cleanTitle(data && data.title) || fallback;
    if (titleCache.size >= TITLE_CACHE_MAX) titleCache.delete(titleCache.keys().next().value);
    titleCache.set(videoId, title);
    return { ok: true, title };
  } catch {
    return { ok: true, title: fallback };
  }
}

function parsePlaylistId(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const list = url.searchParams.get('list');
  return list && /^[A-Za-z0-9_-]{10,64}$/.test(list) ? list : null;
}

// Lists the videos in a public playlist via the YouTube Data API (needs an API key).
// Throws Error with a user-safe message; the key is never included in messages.
async function fetchPlaylistVideos(listId, apiKey, { fetchImpl = globalThis.fetch, maxItems = 200 } = {}) {
  const videos = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ part: 'snippet', maxResults: '50', playlistId: listId, key: apiKey });
    if (pageToken) params.set('pageToken', pageToken);
    let res;
    try {
      res = await fetchImpl(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error('YouTube could not be reached. Try again in a moment.');
    }
    if (res.status === 404) throw new Error("That playlist could not be found or isn't public.");
    if (!res.ok) throw new Error('YouTube did not return that playlist. Try again later.');

    const data = await res.json();
    for (const item of data.items || []) {
      const id = item && item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId;
      if (typeof id === 'string' && VIDEO_ID_RE.test(id)) {
        videos.push({ videoId: id, title: cleanTitle(item.snippet.title) || `Video ${id}` });
      }
    }
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  } while (pageToken && videos.length < maxItems);
  return videos.slice(0, maxItems);
}

module.exports = { parseVideoId, parsePlaylistId, fetchVideoInfo, fetchPlaylistVideos };
