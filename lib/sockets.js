'use strict';

const rooms = require('./room');
const { RoomError, LIMITS } = rooms;
const { parseVideoId, parsePlaylistId, fetchPlaylistVideos } = require('./youtube');
const { createKeyedLimiter } = require('./rate-limit');

// Per-socket budget: 40 events per 10 seconds.
const socketLimiter = createKeyedLimiter({ max: 40, windowMs: 10_000 });

function registerSockets(io, { store, resolveTitle, youtubeApiKey = '', now = Date.now }) {
  const tagOf = (memberId) => store.ownerTag(memberId);
  const snapshotOf = (room) => rooms.snapshot(room, now(), tagOf);
  const broadcast = (room) => {
    io.to(room.id).emit('state', snapshotOf(room));
    store.markDirty();
  };

  io.on('connection', (socket) => {
    let session = null; // { roomId, memberId, isHost }

    const leaveRoom = () => {
      if (!session) return;
      const room = store.get(session.roomId);
      socket.leave(session.roomId);
      session = null;
      if (room && rooms.leave(room, socket.id, now())) broadcast(room);
    };

    const currentRoom = () => {
      if (!session) throw new RoomError('Join a room first.');
      const room = store.get(session.roomId);
      if (!room) {
        session = null;
        throw new RoomError('This room no longer exists.');
      }
      return room;
    };

    // Every client event goes through here: rate limit, then reply { ok, ... } or { ok: false, error }.
    const handle = (event, fn) => {
      // With no data, socket.io passes the ack as the first argument, so take the ack from the end.
      socket.on(event, async (...args) => {
        const reply = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
        const payload = args[0];
        if (!socketLimiter.allow(socket.id)) {
          reply({ ok: false, error: 'Slow down a little.' });
          return;
        }
        try {
          const data = await fn(payload && typeof payload === 'object' ? payload : {});
          reply({ ok: true, ...data });
        } catch (err) {
          if (err instanceof RoomError) {
            reply({ ok: false, error: err.message });
            return;
          }
          console.error(`[socket] ${event} failed:`, err);
          reply({ ok: false, error: 'Something went wrong. Please try again.' });
        }
      });
    };

    handle('ping', () => ({ serverNow: now() }));

    handle('join', ({ roomId, memberId, nickname, hostToken }) => {
      if (!rooms.isValidMemberId(memberId)) throw new RoomError('Invalid session. Reload the page.');
      const room = store.get(roomId);
      if (!room) throw new RoomError('Room not found. Check the invite link.');
      if (session && session.roomId !== room.id) leaveRoom();

      session = { roomId: room.id, memberId, isHost: store.verifyHost(room, hostToken) };
      socket.join(room.id);
      rooms.join(room, {
        socketId: socket.id,
        memberId,
        nickname: rooms.cleanNickname(nickname),
        now: now(),
      });
      broadcast(room);
      return { isHost: session.isHost, you: tagOf(memberId), state: snapshotOf(room) };
    });

    handle('addTrack', async ({ url }) => {
      const room = currentRoom();
      if (typeof url !== 'string' || url.length > LIMITS.maxUrlLength) {
        throw new RoomError("That doesn't look like a YouTube link.");
      }
      const { memberId, isHost } = session;

      const videoId = parseVideoId(url);
      if (!videoId) {
        const listId = parsePlaylistId(url);
        if (listId) return importPlaylist(room, listId, memberId, isHost);
        throw new RoomError("That doesn't look like a YouTube video or playlist link.");
      }

      rooms.assertCanAdd(room, { memberId, isHost, videoId });
      const info = await resolveTitle(videoId);
      if (!info.ok) throw new RoomError("That video can't be found or can't be embedded.");

      // Re-read after the await: the room or membership may have changed meanwhile.
      const fresh = currentRoom();
      rooms.addTrack(fresh, { memberId: session.memberId, isHost: session.isHost, videoId, title: info.title, now: now() });
      broadcast(fresh);
      return { message: 'Added to the pool.' };
    });

    // Adds a playlist's videos in order until a limit stops it. Duplicates are skipped.
    async function importPlaylist(room, listId, memberId, isHost) {
      if (!youtubeApiKey) {
        throw new RoomError('Playlist links need a YouTube API key on the server. Paste single video links instead.');
      }
      let videos;
      try {
        videos = await fetchPlaylistVideos(listId, youtubeApiKey);
      } catch (err) {
        throw new RoomError(err.message);
      }
      if (!videos.length) throw new RoomError('That playlist has no videos.');

      let added = 0;
      let skipped = 0;
      let stopReason = null;
      for (const video of videos) {
        const fresh = currentRoom();
        try {
          rooms.addTrack(fresh, { memberId, isHost, videoId: video.videoId, title: video.title, now: now() });
          added++;
        } catch (err) {
          if (!(err instanceof RoomError)) throw err;
          if (err.message.includes('already in the pool')) {
            skipped++;
            continue;
          }
          stopReason = err.message;
          break;
        }
      }
      if (added) broadcast(room);

      let message = `Added ${added} ${added === 1 ? 'track' : 'tracks'}.`;
      if (skipped) message += ` ${skipped} already in the pool.`;
      if (stopReason) message += ` Stopped: ${stopReason}`;
      if (!added && !stopReason) message = 'Nothing new to add. Every track is already in the pool.';
      return { message };
    }

    handle('removeTrack', ({ trackId }) => {
      const room = currentRoom();
      rooms.removeTrack(room, {
        trackId: String(trackId),
        memberId: session.memberId,
        isHost: session.isHost,
        now: now(),
      });
      broadcast(room);
    });

    handle('updateSettings', ({ settings }) => {
      const room = currentRoom();
      if (!session.isHost) throw new RoomError('Only the host can change settings.');
      rooms.updateSettings(room, settings, now());
      broadcast(room);
    });

    handle('control', ({ action, trackId, position, volume }) => {
      const room = currentRoom();
      rooms.applyControl(room, {
        action: String(action),
        memberId: session.memberId,
        isHost: session.isHost,
        trackId: trackId === undefined || trackId === null ? null : String(trackId),
        position,
        volume,
        now: now(),
      });
      broadcast(room);
    });

    // Auto mix: the host sets a person's share. People are named by their public tag.
    handle('setShare', ({ member, share }) => {
      const room = currentRoom();
      if (!session.isHost) throw new RoomError("Only the host can change people's shares.");
      const memberId = [...room.memberNames.keys()].find((m) => tagOf(m) === member);
      if (!memberId) throw new RoomError('That person is not in this room.');
      rooms.setShare(room, memberId, share, now());
      broadcast(room);
    });

    handle('ended', ({ trackId }) => {
      const room = currentRoom();
      if (rooms.markEnded(room, String(trackId), now())) broadcast(room);
    });

    handle('broken', ({ trackId }) => {
      const room = currentRoom();
      if (rooms.markBroken(room, String(trackId), now())) broadcast(room);
    });

    socket.on('disconnect', () => {
      leaveRoom();
      socketLimiter.forget(socket.id);
    });
  });
}

module.exports = { registerSockets };
