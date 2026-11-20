# TogetherMix

Watch-together rooms for sharing music mixes with a friend group.

- Create a room and send the invite link. No accounts: a nickname is enough.
- Everyone adds their YouTube tracks (or a whole public playlist) to one shared pool.
- Playback is synced for everyone in the room, using the official YouTube player.
- Ten room settings: who adds, limits per person, play order, who controls playback, skip voting, autoplay, loop, lock.
- Google AdSense support, switched on with two environment variables.

Nothing is downloaded or re-hosted. Videos play through YouTube's embedded player.

## Status

- **Unit tests**: 29 passing (`npm test`). They cover room rules, link parsing, and playlist paging with a fake `fetch`.
- **Server, end to end**: verified over Socket.IO against a live server. Covered: create, join, add, duplicate and bad-link rejection, permissions, play/skip/ended/broken, lock, invalid settings, and a restart that kept the room and host key.
- **Not yet verified**:
  - the web UI in a real browser (the scripts parse and their element IDs match, but nobody has clicked through it yet);
  - playlist import with a live YouTube API key;
  - ads serving, which needs an approved AdSense account and a live domain.

## Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm start            # http://localhost:3000
npm test             # unit tests for the room logic and YouTube helpers
```

## How it works

- **Rooms** live in memory and are saved to `data/rooms.json` (debounced). A restart keeps the pool, settings and host key. Rooms come back paused.
- **Identity**: each browser gets a random member ID in `localStorage`. The server never sends raw member IDs to clients; it sends an HMAC tag, so one person cannot impersonate another by copying an ID.
- **Host**: the browser that created the room keeps a host key. Only that key can change settings or remove other people's tracks. Clearing site data loses it. Nobody else can take over the room.
- **Sync**: the server keeps the playback position and the time it was last changed. Clients estimate the server clock with ping round trips, then seek to the expected position when they drift more than 1.5 seconds.
- **Round-robin** (the default) interleaves each person's tracks, so one friend's 40-song mix doesn't block everyone else.
- When the last person leaves, playback pauses.

## Room settings

| Setting | Options | Default |
|---|---|---|
| Who can add tracks | everyone / host only | everyone |
| Max tracks per person | 0 = no limit, up to 200 | 0 |
| Allow the same video twice | on / off | off |
| Play order | round-robin / in the order added / shuffle | round-robin |
| Who controls playback | everyone / host only | everyone |
| Skipping | vote / instant | vote |
| Share of people online needed to skip | 25% / 50% / 75% / 100% | 50% |
| Play the next track automatically | on / off | on |
| Start over when the pool ends | on / off | on |
| Lock the pool | on / off | off |

Host changes apply to the whole room immediately.

## Configuration

Set these as environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SITE_NAME` | `TogetherMix` | Name used in the server log |
| `DATA_FILE` | `data/rooms.json` | Where rooms are saved. Keep this private: it holds the signing secret and host-key hashes. |
| `ROOM_IDLE_DAYS` | `30` | Rooms with no activity this long (and nobody online) are deleted |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the app. Set to `1` behind Nginx or Cloudflare Tunnel so rate limits see real client IPs. |
| `YOUTUBE_API_KEY` | (empty) | Enables playlist import. See below. |
| `ADSENSE_CLIENT` | (empty) | Your publisher ID, e.g. `ca-pub-1234567890123456` |
| `ADSENSE_SLOT` | (empty) | The numeric ID of a display ad unit |

## Playlist import (optional)

Pasting a YouTube playlist link adds up to 200 of its videos, in order. Duplicates are skipped, and the add stops if a limit is hit.

This uses the YouTube Data API v3, which needs a key:

1. Google Cloud Console → create or pick a project → enable **YouTube Data API v3**.
2. Create an **API key** and restrict it to the YouTube Data API.
3. Set `YOUTUBE_API_KEY` on the server.

The free quota is far more than a friend group needs. Only public and unlisted playlists can be imported.

Single video links work without a key. Titles come from YouTube's public oEmbed endpoint.

## Google AdSense

Ads are only loaded when both `ADSENSE_CLIENT` and `ADSENSE_SLOT` are set. Until then, the ad boxes stay hidden.

1. **Apply** at adsense.google.com with your live site URL. The site needs real content, a privacy policy and a domain you control. Approval can take days to weeks.
2. Once approved, copy your publisher ID (`ca-pub-…`) into `ADSENSE_CLIENT`.
3. In AdSense, create a **Display ad unit** (responsive). Copy its numeric ID into `ADSENSE_SLOT`.
4. Replace the contact line in [public/privacy.html](public/privacy.html) with a real contact address.
5. `/ads.txt` is generated automatically from `ADSENSE_CLIENT`. Check it at `https://your-domain/ads.txt` after deploying.
6. **Consent**: for visitors in the EEA, UK and Switzerland, Google requires a consent message before ads can be personalised. Set this up in AdSense under *Privacy & messaging*. Without it, ad revenue from those regions is limited.

Ad placement is deliberately outside the player and away from the controls. Keep it that way. AdSense policy forbids encouraging clicks or placing ads where users may click them by accident.

## Deploying

- Run it behind HTTPS (required for the clipboard and for YouTube playback in some browsers). Caddy, Nginx with Let's Encrypt, or Cloudflare all work.
- The reverse proxy must pass WebSocket upgrades through to Socket.IO.
- Keep it to **one process**. Rooms live in that process's memory and in one data file, so running several instances would split rooms.
- Back up `data/rooms.json` if you care about the pool history.
- Set `TRUST_PROXY` to the number of proxies in front of the app.

## Limits and known gaps

- Rooms are capped at 5,000 and tracks at 500 per room.
- The server holds no user accounts, so there is no moderation tooling. Anyone with the invite link can join and add tracks. Use **Only the host** settings to restrict this.
- The permission settings are rules for the room, not a security boundary. The app's own UI follows them, but someone who writes their own client can still send events. Good enough for a friend group; not for a public room.
- A lost host key cannot be recovered. The room keeps playing, but nobody can change its settings.
- YouTube can block embedding for some videos, and playback can hit ads that YouTube inserts. The app reports unplayable tracks and skips them.
- Copyright: sharing a link to a video is the same as embedding it. You are responsible for what your group plays, and YouTube's terms and AdSense's content policies apply to the site.

## Troubleshooting

- **"Connection problem…" or "Reconnecting…" forever**: the reverse proxy is probably not passing WebSocket upgrades to Socket.IO.
- **Clicking Add with a playlist link says it needs an API key**: set `YOUTUBE_API_KEY` and restart. Single video links don't need it.
- **Ad boxes missing**: both `ADSENSE_CLIENT` and `ADSENSE_SLOT` must be set, and the ID formats must match the examples above. An ad blocker also hides them.
- **Rooms disappeared after a restart**: check that `DATA_FILE` still points at the same file. Rooms idle for `ROOM_IDLE_DAYS` (and nobody online) are deleted.
- **Everyone's playback drifts**: clients correct drift only when it exceeds 1.5 seconds. Small differences are expected on slow networks.

## Project layout

```
server.js            HTTP routes, AdSense config, ads.txt, Socket.IO startup
lib/room.js          Room rules: pool, play order, playback, permissions, settings (pure logic)
lib/store.js         In-memory rooms with JSON persistence, host-key check, expiry
lib/sockets.js       Realtime events: join, add, remove, control, ended, broken, settings
lib/youtube.js       Link parsing, oEmbed titles, playlist import
lib/config.js        Environment configuration
lib/rate-limit.js    Sliding-window limiter
public/index.html    Create and join rooms
public/room.html     The room: player, pool, settings
public/privacy.html  Privacy policy (required by AdSense)
public/js/           Browser code (common.js holds AdSense loading and the settings form)
test/                Unit tests (node:test)
```
