'use strict';

// Pure room logic: pool, play order, playback state, permissions and settings.
// No I/O here, so it can be unit-tested directly (see test/room.test.js).

const crypto = require('node:crypto');

class RoomError extends Error {}

const LIMITS = Object.freeze({
  maxTracks: 500,
  maxRooms: 5000,
  maxRoomNameLength: 50,
  maxNicknameLength: 24,
  maxPerMemberCap: 200,
  maxSeekSeconds: 43200,
  maxUrlLength: 300,
});

const ROOM_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_ID_LENGTH = 10;
const ROOM_ID_RE = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const CHOICES = Object.freeze({
  addPolicy: ['everyone', 'host'],
  order: ['round-robin', 'added', 'shuffle'],
  controls: ['everyone', 'host'],
  skipMode: ['vote', 'instant'],
});
const BOOLEAN_SETTINGS = ['allowDuplicates', 'autoplay', 'loop', 'locked'];

const DEFAULT_SETTINGS = Object.freeze({
  addPolicy: 'everyone', // who may add tracks: everyone | host
  maxPerMember: 0, // tracks per person, 0 = unlimited
  allowDuplicates: false,
  order: 'round-robin', // round-robin (take turns between mixes) | added | shuffle
  controls: 'everyone', // who may play, pause, seek, select, skip: everyone | host
  skipMode: 'vote', // vote (share of online people) | instant
  voteRatio: 0.5, // share of online people needed to skip, 0.1..1
  autoplay: true, // continue to the next track automatically
  loop: true, // start over when the pool ends
  locked: false, // no new tracks
});

const isValidRoomId = (value) => typeof value === 'string' && ROOM_ID_RE.test(value);
const isValidMemberId = (value) => typeof value === 'string' && MEMBER_ID_RE.test(value);

function randomString(length, alphabet) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}
const newRoomId = () => randomString(ROOM_ID_LENGTH, ROOM_ID_ALPHABET);
const newTrackId = () => crypto.randomBytes(9).toString('base64url');

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const cleanNickname = (value) => cleanText(value, LIMITS.maxNicknameLength) || 'Guest';

function cleanRoomName(value) {
  const name = cleanText(value, LIMITS.maxRoomNameLength);
  if (!name) throw new RoomError('Give the room a name.');
  return name;
}

function parsePosition(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > LIMITS.maxSeekSeconds) {
    throw new RoomError('Invalid playback position.');
  }
  return seconds;
}

// Merges a partial settings object over `base`. Unknown keys are ignored.
function sanitizeSettings(input, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  if (input === undefined || input === null) return out;
  if (typeof input !== 'object' || Array.isArray(input)) throw new RoomError('Invalid settings.');

  for (const [key, allowed] of Object.entries(CHOICES)) {
    if (input[key] === undefined) continue;
    if (!allowed.includes(input[key])) throw new RoomError(`Invalid value for ${key}.`);
    out[key] = input[key];
  }
  for (const key of BOOLEAN_SETTINGS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new RoomError(`${key} must be true or false.`);
    out[key] = input[key];
  }
  if (input.maxPerMember !== undefined) {
    const n = Number(input.maxPerMember);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxPerMemberCap) {
      throw new RoomError(`Max tracks per person must be 0 to ${LIMITS.maxPerMemberCap}.`);
    }
    out.maxPerMember = n;
  }
  if (input.voteRatio !== undefined) {
    const n = Number(input.voteRatio);
    if (!Number.isFinite(n) || n < 0.1 || n > 1) {
      throw new RoomError('The share needed to skip must be between 10% and 100%.');
    }
    out.voteRatio = n;
  }
  return out;
}

function createRoom({ id, name, settings, hostMemberId, hostTokenHash, now }) {
  return {
    id,
    name,
    settings: { ...settings },
    createdAt: now,
    lastActivity: now,
    hostMemberId,
    hostTokenHash,
    tracks: [], // in the order they were added
    playback: { trackId: null, playing: false, position: 0, anchorAt: now },
    memberNames: new Map(), // memberId -> nickname (private)
    online: new Map(), // socketId -> memberId (runtime only)
    votes: new Set(), // memberIds voting to skip the current track (runtime only)
  };
}

function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    settings: room.settings,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    hostMemberId: room.hostMemberId,
    hostTokenHash: room.hostTokenHash,
    tracks: room.tracks,
    playback: { trackId: room.playback.trackId, position: currentPosition(room, Date.now()) },
    memberNames: Object.fromEntries(room.memberNames),
  };
}

// After a restart nobody is connected, so the room comes back paused.
function restoreRoom(data) {
  return {
    id: data.id,
    name: data.name,
    settings: sanitizeSettings(data.settings),
    createdAt: data.createdAt,
    lastActivity: data.lastActivity,
    hostMemberId: data.hostMemberId,
    hostTokenHash: data.hostTokenHash,
    tracks: Array.isArray(data.tracks) ? data.tracks : [],
    playback: {
      trackId: data.playback && data.playback.trackId ? data.playback.trackId : null,
      playing: false,
      position: data.playback ? Number(data.playback.position) || 0 : 0,
      anchorAt: Date.now(),
    },
    memberNames: new Map(Object.entries(data.memberNames || {})),
    online: new Map(),
    votes: new Set(),
  };
}

// ---- play order -------------------------------------------------------------

// Interleaves each member's tracks: A1, B1, C1, A2, B2, ...
function roundRobin(tracks) {
  const lanes = new Map();
  for (const track of tracks) {
    if (!lanes.has(track.memberId)) lanes.set(track.memberId, []);
    lanes.get(track.memberId).push(track);
  }
  const queues = [...lanes.values()];
  const out = [];
  for (let round = 0; out.length < tracks.length; round++) {
    for (const queue of queues) {
      if (round < queue.length) out.push(queue[round]);
    }
  }
  return out;
}

// Full play order, including broken tracks (they are skipped during playback).
function playOrder(room) {
  switch (room.settings.order) {
    case 'shuffle':
      return [...room.tracks].sort((a, b) => a.rank - b.rank);
    case 'added':
      return [...room.tracks];
    default:
      return roundRobin(room.tracks);
  }
}

function firstPlayableId(room) {
  const track = playOrder(room).find((t) => !t.broken);
  return track ? track.id : null;
}

// Next playable track after `fromId`, honouring the loop setting.
function nextTrackId(room, fromId) {
  const order = playOrder(room);
  const idx = fromId ? order.findIndex((t) => t.id === fromId) : -1;
  for (let i = idx + 1; i < order.length; i++) {
    if (!order[i].broken) return order[i].id;
  }
  if (idx < 0 || room.settings.loop) return firstPlayableId(room);
  return null;
}

// ---- presence and voting ----------------------------------------------------

function onlineMemberIds(room) {
  return new Set(room.online.values());
}

function neededVotes(room) {
  return Math.max(1, Math.ceil(onlineMemberIds(room).size * room.settings.voteRatio));
}

function currentVotes(room) {
  const online = onlineMemberIds(room);
  let count = 0;
  for (const memberId of room.votes) if (online.has(memberId)) count++;
  return count;
}

// ---- playback ---------------------------------------------------------------

function currentPosition(room, now) {
  const pb = room.playback;
  if (!pb.playing) return pb.position;
  return pb.position + Math.max(0, now - pb.anchorAt) / 1000;
}

function touch(room, now) {
  room.lastActivity = now;
}

function goTo(room, trackId, now, playing) {
  room.playback = {
    trackId: trackId || null,
    playing: Boolean(trackId) && playing,
    position: 0,
    anchorAt: now,
  };
  room.votes.clear();
}

function advance(room, now, playing) {
  goTo(room, nextTrackId(room, room.playback.trackId), now, playing);
}

function findTrack(room, trackId) {
  const track = room.tracks.find((t) => t.id === trackId);
  if (!track) throw new RoomError('That track is no longer in the pool.');
  return track;
}

// ---- pool -------------------------------------------------------------------

function assertCanAdd(room, { memberId, isHost, videoId }) {
  const s = room.settings;
  if (s.locked) throw new RoomError('The pool is locked.');
  if (s.addPolicy === 'host' && !isHost) throw new RoomError('Only the host can add tracks.');
  if (room.tracks.length >= LIMITS.maxTracks) throw new RoomError('The pool is full.');
  if (!s.allowDuplicates && room.tracks.some((t) => t.videoId === videoId)) {
    throw new RoomError('That video is already in the pool.');
  }
  if (s.maxPerMember > 0) {
    const mine = room.tracks.filter((t) => t.memberId === memberId).length;
    if (mine >= s.maxPerMember) {
      throw new RoomError(`You already have ${s.maxPerMember} tracks in this pool.`);
    }
  }
}

function addTrack(room, { memberId, isHost, videoId, title, now }) {
  assertCanAdd(room, { memberId, isHost, videoId });
  const track = {
    id: newTrackId(),
    videoId,
    title,
    memberId,
    rank: crypto.randomInt(2 ** 31),
    broken: false,
  };
  room.tracks.push(track);
  if (!room.playback.trackId) goTo(room, firstPlayableId(room), now, false);
  touch(room, now);
  return track;
}

function removeTrack(room, { trackId, memberId, isHost, now }) {
  const idx = room.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) throw new RoomError('That track is already gone.');
  const track = room.tracks[idx];
  if (!isHost && track.memberId !== memberId) {
    throw new RoomError('You can only remove your own tracks.');
  }

  const wasCurrent = room.playback.trackId === trackId;
  const playing = room.playback.playing;
  const nextId = wasCurrent ? nextTrackId(room, trackId) : null;
  room.tracks.splice(idx, 1);

  if (wasCurrent) {
    const stillThere = nextId && room.tracks.some((t) => t.id === nextId);
    goTo(room, stillThere ? nextId : firstPlayableId(room), now, playing);
  }
  touch(room, now);
}

// ---- controls ---------------------------------------------------------------

// action: play | pause | seek | select | skip
function applyControl(room, { action, memberId, isHost, trackId, position, now }) {
  const s = room.settings;
  if (!isHost && s.controls === 'host') {
    throw new RoomError('Only the host can control playback in this room.');
  }
  const pb = room.playback;
  const hasPosition = position !== undefined && position !== null;

  switch (action) {
    case 'play': {
      if (!pb.trackId) {
        const first = firstPlayableId(room);
        if (!first) throw new RoomError('The pool is empty.');
        goTo(room, first, now, true);
        break;
      }
      if (pb.playing) break;
      pb.position = hasPosition ? parsePosition(position) : currentPosition(room, now);
      pb.playing = true;
      pb.anchorAt = now;
      break;
    }
    case 'pause': {
      if (!pb.playing) break;
      pb.position = hasPosition ? parsePosition(position) : currentPosition(room, now);
      pb.playing = false;
      pb.anchorAt = now;
      break;
    }
    case 'seek': {
      if (!pb.trackId) throw new RoomError('Nothing is playing.');
      pb.position = parsePosition(position);
      pb.anchorAt = now;
      break;
    }
    case 'select': {
      const track = findTrack(room, trackId);
      if (track.broken) throw new RoomError('That track is unavailable.');
      goTo(room, track.id, now, true);
      break;
    }
    case 'skip': {
      if (!pb.trackId) break;
      if (!isHost && s.skipMode === 'vote') {
        room.votes.add(memberId);
        if (currentVotes(room) >= neededVotes(room)) advance(room, now, true);
        break;
      }
      advance(room, now, true);
      break;
    }
    default:
      throw new RoomError('Unknown action.');
  }
  touch(room, now);
}

// The player reports the end of a track. Ignored if that track is no longer current.
function markEnded(room, trackId, now) {
  if (!room.playback.trackId || room.playback.trackId !== trackId) return false;
  advance(room, now, room.settings.autoplay);
  touch(room, now);
  return true;
}

// The player could not play the current track (removed, private, not embeddable).
function markBroken(room, trackId, now) {
  if (room.playback.trackId !== trackId) return false;
  const track = room.tracks.find((t) => t.id === trackId);
  if (!track || track.broken) return false;
  track.broken = true;
  advance(room, now, room.playback.playing);
  touch(room, now);
  return true;
}

function updateSettings(room, input, now) {
  room.settings = sanitizeSettings(input, room.settings);
  touch(room, now);
}

// ---- presence ---------------------------------------------------------------

function join(room, { socketId, memberId, nickname, now }) {
  room.online.set(socketId, memberId);
  room.memberNames.set(memberId, nickname);
  touch(room, now);
}

// When the last person leaves, playback pauses so nobody comes back to a finished mix.
function leave(room, socketId, now) {
  if (!room.online.delete(socketId)) return false;
  if (room.online.size === 0 && room.playback.playing) {
    room.playback = {
      ...room.playback,
      playing: false,
      position: currentPosition(room, now),
      anchorAt: now,
    };
  }
  touch(room, now);
  return true;
}

// ---- client view -------------------------------------------------------------

// `ownerTag` maps a memberId to an opaque tag, so memberIds are never sent to clients.
function snapshot(room, now, ownerTag) {
  const online = onlineMemberIds(room);
  const pb = room.playback;
  return {
    id: room.id,
    name: room.name,
    settings: room.settings,
    serverNow: now,
    tracks: playOrder(room).map((t) => ({
      id: t.id,
      videoId: t.videoId,
      title: t.title,
      owner: ownerTag(t.memberId),
      addedBy: room.memberNames.get(t.memberId) || 'Guest',
      broken: t.broken,
    })),
    playback: {
      trackId: pb.trackId,
      playing: pb.playing,
      position: currentPosition(room, now),
    },
    members: [...online].map((memberId) => ({
      id: ownerTag(memberId),
      nickname: room.memberNames.get(memberId) || 'Guest',
      isHost: memberId === room.hostMemberId,
    })),
    skip: { votes: currentVotes(room), needed: neededVotes(room) },
  };
}

module.exports = {
  RoomError,
  LIMITS,
  DEFAULT_SETTINGS,
  isValidRoomId,
  isValidMemberId,
  newRoomId,
  cleanNickname,
  cleanRoomName,
  sanitizeSettings,
  createRoom,
  serializeRoom,
  restoreRoom,
  playOrder,
  nextTrackId,
  currentPosition,
  neededVotes,
  assertCanAdd,
  addTrack,
  removeTrack,
  applyControl,
  markEnded,
  markBroken,
  updateSettings,
  join,
  leave,
  snapshot,
};
