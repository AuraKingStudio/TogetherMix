'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../lib/room');
const party = require('../lib/game');

const A = 'memberAAAAAAAAAAAAAA';
const B = 'memberBBBBBBBBBBBBBB';

function newRoom(settings = {}) {
  return rooms.createRoom({
    id: 'abcdefghjk',
    name: 'Party',
    settings: rooms.sanitizeSettings(settings),
    hostMemberId: A,
    hostTokenHash: 'x',
    now: 0,
  });
}
let vid = 0;
const add = (room, memberId) => rooms.addTrack(room, {
  memberId, isHost: memberId === A, videoId: `video${String(vid++).padStart(6, '0')}`, title: `Song ${vid}`, now: 0,
});
const tag = (m) => `tag-${m.slice(-4)}`;

test('levels and ranks grow with XP', () => {
  assert.equal(party.levelFor(0), 1);
  assert.equal(party.levelFor(49), 1);
  assert.equal(party.levelFor(50), 2);
  assert.equal(party.levelFor(800), 5);
  assert.equal(party.rankFor(1), 'Rookie');
  assert.equal(party.rankFor(6), 'DJ');
  assert.equal(party.rankFor(30), 'Legend');
});

test('playing tracks fills the history and gives XP to whoever added them', () => {
  const room = newRoom();
  add(room, B); // autoplay: starts at once
  assert.equal(room.history.length, 1);
  const p = party.profileOf(room, B);
  assert.equal(p.xp, party.XP.addTrack + party.XP.trackPlayed);
});

test('ratings: 1 to 5 stars, re-rating replaces, history sorted by stars', () => {
  const room = newRoom({ autoplay: true });
  const t1 = add(room, A);
  const t2 = add(room, B);
  rooms.goTo(room, t2.id, 10, true);
  party.rate(room, { videoId: t2.videoId, memberId: A, stars: 5 });
  party.rate(room, { videoId: t1.videoId, memberId: B, stars: 2 });
  party.rate(room, { videoId: t1.videoId, memberId: B, stars: 3 });
  assert.throws(() => party.rate(room, { videoId: t1.videoId, memberId: A, stars: 6 }), party.GameError);
  assert.throws(() => party.rate(room, { videoId: 'neverplayed', memberId: A, stars: 3 }), party.GameError);
  const view = party.historyView(room, () => 'x', tag);
  assert.deepEqual(view.map((h) => h.videoId), [t2.videoId, t1.videoId]);
  assert.equal(view[1].rating, 3);
  assert.equal(view[0].votes[tag(A)], 5);
});

test('quick draw: false start loses, fastest tap wins and picks from their top 3', () => {
  const room = newRoom();
  add(room, A);
  const mine = [add(room, B), add(room, B), add(room, B), add(room, B)];
  const game = party.startGame(room, { kind: 'reaction', players: [A, B], now: 0, rand: () => 0 });
  party.gameInput(room, { memberId: A, now: game.goAt - 10 }); // too early
  const done = party.gameInput(room, { memberId: B, now: game.goAt + 250 });
  assert.equal(done, true);
  party.finishGame(room, { now: game.goAt + 300, topTracks: (m) => rooms.topTracksOf(room, m) });
  assert.equal(room.game.winner, B);
  assert.equal(room.game.phase, 'pick');
  assert.deepEqual(room.game.choices, mine.slice(0, 3).map((t) => t.id));
  assert.throws(() => party.pickTrack(room, { memberId: A, trackId: mine[0].id }), party.GameError);
  assert.equal(party.pickTrack(room, { memberId: B, trackId: mine[1].id }), mine[1].id);
  assert.equal(party.profileOf(room, B).wins, 1);
  assert.equal(party.profileOf(room, A).winRatio, 0);
  assert.equal(party.profileOf(room, B).winRatio, 100);
});

test('tap frenzy: most taps wins and taps are capped to a human pace', () => {
  const room = newRoom();
  const game = party.startGame(room, { kind: 'mash', players: [A, B], now: 0, rand: () => 0 });
  party.gameInput(room, { memberId: A, taps: 40, now: game.goAt + 100 });
  party.gameInput(room, { memberId: B, taps: 9999, now: game.goAt + 100 });
  assert.equal(room.game.results.get(B).taps, 100);
  party.finishGame(room, { now: game.endsAt, topTracks: () => [] });
  assert.equal(room.game.winner, B);
  assert.equal(room.game.phase, 'done'); // nothing queued to pick
  assert.throws(() => party.startGame(room, { players: [] , now: 1, rand: () => 0 }), party.GameError);
});

test('only one game at a time, and late joiners cannot play', () => {
  const room = newRoom();
  party.startGame(room, { kind: 'mash', players: [A], now: 0, rand: () => 0 });
  assert.throws(() => party.startGame(room, { players: [A], now: 1, rand: () => 0 }), party.GameError);
  assert.throws(() => party.gameInput(room, { memberId: B, taps: 3, now: 5000 }), party.GameError);
});

test('history, ratings, XP and stats survive a save and restore', () => {
  const room = newRoom();
  const t = add(room, B);
  party.rate(room, { videoId: t.videoId, memberId: A, stars: 4 });
  const back = rooms.restoreRoom(JSON.parse(JSON.stringify(rooms.serializeRoom(room))));
  assert.equal(back.history.length, 1);
  assert.equal(party.ratingOf(back, t.videoId).average, 4);
  assert.equal(party.profileOf(back, B).xp, party.profileOf(room, B).xp);
  assert.equal(back.game, null);
});

test('replay plays a song from the history again, re-adding it if it was removed', () => {
  const room = newRoom();
  const t = add(room, A);
  add(room, A);
  rooms.removeTrack(room, { trackId: t.id, memberId: A, isHost: true, now: 1 });
  rooms.replay(room, { videoId: t.videoId, memberId: B, isHost: false, now: 2 });
  const playing = room.tracks.find((x) => x.id === room.playback.trackId);
  assert.equal(playing.videoId, t.videoId);
  assert.equal(room.playback.playing, true);
});
