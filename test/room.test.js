'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../lib/room');
const { parseVideoId } = require('../lib/youtube');

const ME = 'member-aaaaaaaaaaaaaaaa';
const FRIEND = 'member-bbbbbbbbbbbbbbbb';
const THIRD = 'member-cccccccccccccccc';
const crypto = require('node:crypto');

// Stand-in for store.ownerTag (an HMAC in production); the output must not contain the ID.
const tag = (id) => crypto.createHash('sha256').update(id).digest('base64url').slice(0, 16);

function newRoom(settings = {}) {
  const room = rooms.createRoom({
    id: 'abcdefghjk',
    name: 'Test',
    settings: rooms.sanitizeSettings(settings),
    hostMemberId: ME,
    hostTokenHash: 'x',
    now: 0,
  });
  return room;
}

let videoCounter = 0;
function add(room, memberId, { isHost = false, now = 1000, title } = {}) {
  videoCounter++;
  const videoId = `vid${String(videoCounter).padStart(8, '0')}`;
  return rooms.addTrack(room, { memberId, isHost, videoId, title: title || videoId, now });
}

function online(room, ...memberIds) {
  memberIds.forEach((m, i) => rooms.join(room, { socketId: `s${m}${i}`, memberId: m, nickname: `Nick${i}`, now: 0 }));
}

test('parseVideoId accepts common YouTube link shapes', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(parseVideoId(id), id);
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${id}&t=10`), id);
  assert.equal(parseVideoId(`https://youtu.be/${id}?si=abc`), id);
  assert.equal(parseVideoId(`https://music.youtube.com/watch?v=${id}`), id);
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(parseVideoId(`https://m.youtube.com/embed/${id}`), id);
});

test('parseVideoId rejects non-YouTube and malformed input', () => {
  assert.equal(parseVideoId('https://evil.example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseVideoId('javascript:alert(1)'), null);
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=short'), null);
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=<script>'), null);
  assert.equal(parseVideoId(''), null);
  assert.equal(parseVideoId(42), null);
});

test('sanitizeSettings merges partial input and rejects bad values', () => {
  const merged = rooms.sanitizeSettings({ order: 'shuffle', loop: false, unknown: 1 });
  assert.equal(merged.order, 'shuffle');
  assert.equal(merged.loop, false);
  assert.equal(merged.controls, 'everyone');
  assert.equal(merged.unknown, undefined);
  assert.throws(() => rooms.sanitizeSettings({ order: 'random' }), rooms.RoomError);
  assert.throws(() => rooms.sanitizeSettings({ loop: 'yes' }), rooms.RoomError);
  assert.throws(() => rooms.sanitizeSettings({ maxPerMember: 1.5 }), rooms.RoomError);
  assert.throws(() => rooms.sanitizeSettings({ maxPerMember: 999 }), rooms.RoomError);
  assert.throws(() => rooms.sanitizeSettings({ voteRatio: 0 }), rooms.RoomError);
  assert.throws(() => rooms.sanitizeSettings([]), rooms.RoomError);
});

test('round-robin interleaves each person\'s mix', () => {
  const room = newRoom({ order: 'round-robin' });
  const a1 = add(room, ME);
  const a2 = add(room, ME);
  const b1 = add(room, FRIEND);
  const b2 = add(room, FRIEND);
  const b3 = add(room, FRIEND);
  const order = rooms.playOrder(room).map((t) => t.id);
  assert.deepEqual(order, [a1.id, b1.id, a2.id, b2.id, b3.id]);
});

test('added order keeps insertion order', () => {
  const room = newRoom({ order: 'added' });
  const a = add(room, ME);
  const b = add(room, FRIEND);
  const c = add(room, ME);
  assert.deepEqual(rooms.playOrder(room).map((t) => t.id), [a.id, b.id, c.id]);
});

test('shuffle is stable between calls', () => {
  const room = newRoom({ order: 'shuffle' });
  for (let i = 0; i < 10; i++) add(room, ME);
  const first = rooms.playOrder(room).map((t) => t.id);
  const second = rooms.playOrder(room).map((t) => t.id);
  assert.deepEqual(first, second);
});

test('duplicates and per-person caps are enforced', () => {
  const room = newRoom({ maxPerMember: 2 });
  add(room, ME);
  add(room, ME);
  assert.throws(() => rooms.assertCanAdd(room, { memberId: ME, isHost: false, videoId: 'newvideo123' }), /already have 2/);
  rooms.assertCanAdd(room, { memberId: FRIEND, isHost: false, videoId: 'newvideo123' });

  const dup = newRoom({ allowDuplicates: false });
  rooms.addTrack(dup, { memberId: ME, isHost: false, videoId: 'samevideo01', title: 't', now: 0 });
  assert.throws(
    () => rooms.addTrack(dup, { memberId: FRIEND, isHost: false, videoId: 'samevideo01', title: 't', now: 0 }),
    /already in the pool/,
  );
});

test('addPolicy host and locked block non-host adds', () => {
  const hostOnly = newRoom({ addPolicy: 'host' });
  assert.throws(() => add(hostOnly, FRIEND), /Only the host/);
  add(hostOnly, ME, { isHost: true });

  const locked = newRoom({ locked: true });
  assert.throws(() => add(locked, ME, { isHost: true }), /locked/);
});

test('first added track is cued, not auto-played', () => {
  const room = newRoom();
  const t = add(room, ME);
  assert.equal(room.playback.trackId, t.id);
  assert.equal(room.playback.playing, false);
});

test('playing and pausing track position on the server clock', () => {
  const room = newRoom();
  const t = add(room, ME);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 1000 });
  assert.equal(room.playback.playing, true);
  assert.equal(rooms.currentPosition(room, 4000), 3);
  rooms.applyControl(room, { action: 'pause', memberId: ME, isHost: false, now: 4000 });
  assert.equal(room.playback.playing, false);
  assert.equal(rooms.currentPosition(room, 9000), 3);
  rooms.applyControl(room, { action: 'seek', memberId: ME, isHost: false, position: 42, now: 9000 });
  assert.equal(rooms.currentPosition(room, 9000), 42);
  assert.equal(room.playback.trackId, t.id);
});

test('play accepts the position reported by the local player', () => {
  const room = newRoom();
  add(room, ME);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, position: 75, now: 0 });
  assert.equal(rooms.currentPosition(room, 1000), 76);
});

test('controls=host blocks everyone except the host', () => {
  const room = newRoom({ controls: 'host' });
  add(room, ME);
  assert.throws(
    () => rooms.applyControl(room, { action: 'play', memberId: FRIEND, isHost: false, now: 0 }),
    /Only the host/,
  );
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: true, now: 0 });
  assert.equal(room.playback.playing, true);
});

test('vote skip needs the configured share of people online', () => {
  const room = newRoom({ skipMode: 'vote', voteRatio: 0.5 });
  add(room, ME);
  add(room, FRIEND);
  online(room, ME, FRIEND, THIRD);
  const first = room.playback.trackId;

  rooms.applyControl(room, { action: 'skip', memberId: FRIEND, isHost: false, now: 0 });
  assert.equal(room.playback.trackId, first, 'one vote of three is not enough');
  rooms.applyControl(room, { action: 'skip', memberId: THIRD, isHost: false, now: 0 });
  assert.notEqual(room.playback.trackId, first, 'two of three is enough at 50%');
});

test('instant skip advances immediately', () => {
  const room = newRoom({ skipMode: 'instant' });
  const a = add(room, ME);
  const b = add(room, FRIEND);
  online(room, ME, FRIEND);
  rooms.applyControl(room, { action: 'skip', memberId: FRIEND, isHost: false, now: 0 });
  assert.notEqual(room.playback.trackId, a.id);
  assert.equal(room.playback.trackId, b.id);
});

test('autoplay off cues the next track paused; loop wraps around', () => {
  const room = newRoom({ autoplay: false, loop: true });
  const a = add(room, ME);
  const b = add(room, FRIEND);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 0 });
  assert.equal(rooms.markEnded(room, a.id, 100), true);
  assert.equal(room.playback.trackId, b.id);
  assert.equal(room.playback.playing, false);
  rooms.markEnded(room, b.id, 200);
  assert.equal(room.playback.trackId, a.id, 'loop returns to the first track');
});

test('pool ends cleanly when loop is off', () => {
  const room = newRoom({ loop: false, autoplay: true });
  const a = add(room, ME);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 0 });
  rooms.markEnded(room, a.id, 10);
  assert.equal(room.playback.trackId, null);
  assert.equal(room.playback.playing, false);
});

test('ended from a stale track is ignored', () => {
  const room = newRoom();
  const a = add(room, ME);
  add(room, FRIEND);
  assert.equal(rooms.markEnded(room, 'some-old-track', 0), false);
  assert.equal(room.playback.trackId, a.id);
});

test('broken tracks are skipped and marked', () => {
  const room = newRoom();
  const a = add(room, ME);
  const b = add(room, FRIEND);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 0 });
  assert.equal(rooms.markBroken(room, a.id, 5), true);
  assert.equal(room.playback.trackId, b.id);
  assert.equal(room.playback.playing, true, 'keeps playing when it was playing');
  assert.equal(rooms.markBroken(room, a.id, 6), false, 'reporting twice does nothing');
});

test('removing the current track moves on to the next one', () => {
  const room = newRoom({ order: 'added' });
  const a = add(room, ME);
  const b = add(room, FRIEND);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 0 });
  rooms.removeTrack(room, { trackId: a.id, memberId: ME, isHost: false, now: 10 });
  assert.equal(room.playback.trackId, b.id);
  assert.equal(room.playback.playing, true);
});

test('removing the last track empties the playback', () => {
  const room = newRoom();
  const a = add(room, ME);
  rooms.removeTrack(room, { trackId: a.id, memberId: ME, isHost: false, now: 0 });
  assert.equal(room.playback.trackId, null);
  assert.equal(room.tracks.length, 0);
});

test('people can only remove their own tracks unless they are host', () => {
  const room = newRoom();
  const a = add(room, ME);
  assert.throws(() => rooms.removeTrack(room, { trackId: a.id, memberId: FRIEND, isHost: false, now: 0 }), /own tracks/);
  rooms.removeTrack(room, { trackId: a.id, memberId: FRIEND, isHost: true, now: 0 });
  assert.equal(room.tracks.length, 0);
});

test('last person leaving pauses the room', () => {
  const room = newRoom();
  add(room, ME);
  online(room, ME);
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 0 });
  rooms.leave(room, `s${ME}0`, 5000);
  assert.equal(room.playback.playing, false);
  assert.equal(room.playback.position, 5);
});

test('snapshot never exposes raw member IDs', () => {
  const room = newRoom();
  add(room, ME, { title: 'Song' });
  online(room, ME);
  const snap = rooms.snapshot(room, 0, tag);
  const json = JSON.stringify(snap);
  assert.equal(json.includes(ME), false);
  assert.equal(snap.tracks[0].owner, tag(ME));
  assert.equal(snap.members[0].isHost, true);
});

test('serialize and restore keep the pool and come back paused', () => {
  const room = newRoom();
  const a = add(room, ME, { title: 'Kept' });
  room.memberNames.set(ME, 'Kiels');
  rooms.applyControl(room, { action: 'play', memberId: ME, isHost: false, now: 0 });
  const data = JSON.parse(JSON.stringify(rooms.serializeRoom(room)));
  const back = rooms.restoreRoom(data);
  assert.equal(back.tracks[0].id, a.id);
  assert.equal(back.memberNames.get(ME), 'Kiels');
  assert.equal(back.playback.playing, false);
});

test('nickname and room name are cleaned', () => {
  assert.equal(rooms.cleanNickname('  Kiel\u0007s   '), 'Kiel s');
  assert.equal(rooms.cleanNickname(''), 'Guest');
  assert.throws(() => rooms.cleanRoomName('   '), rooms.RoomError);
});
