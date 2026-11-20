'use strict';

// Party layer for a room: play history, star ratings, XP / levels / ranks, and
// quick mini-games whose winner picks the next song.
//
// Everything here runs on the host (the Node server, or the host browser in the
// static build), so every player sees the same history, scores and results.
// Like the rest of the room, it works on plain data and takes `now` and `rand`
// as arguments, which keeps it testable.

class GameError extends Error {}

const HISTORY_MAX = 60;

// ---- XP, levels, ranks -------------------------------------------------------

const XP = Object.freeze({
  addTrack: 10, // you added a track
  trackPlayed: 15, // one of your tracks started playing
  rateGiven: 2, // you rated a track
  starReceived: 3, // per star someone gave your track
  gamePlayed: 10, // you took part in a mini-game
  gameWon: 50, // you won a mini-game
});

const RANKS = [
  [1, 'Rookie'],
  [2, 'Listener'],
  [4, 'Crate Digger'],
  [6, 'DJ'],
  [9, 'Selector'],
  [13, 'Headliner'],
  [18, 'Legend'],
];

// Level n needs 50 * (n-1)^2 XP: 0, 50, 200, 450, 800...
const levelFor = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1;
const xpForLevel = (level) => 50 * (level - 1) ** 2;

function rankFor(level) {
  let name = RANKS[0][1];
  for (const [min, rank] of RANKS) if (level >= min) name = rank;
  return name;
}

function ensureParty(room) {
  if (!room.xp) room.xp = new Map(); // memberId -> xp
  if (!room.stats) room.stats = new Map(); // memberId -> { games, wins }
  if (!room.history) room.history = []; // newest last
  if (!room.ratings) room.ratings = new Map(); // videoId -> Map(memberId -> stars)
  if (room.game === undefined) room.game = null; // runtime only
  return room;
}

function addXp(room, memberId, amount) {
  ensureParty(room);
  if (!memberId || !amount) return;
  room.xp.set(memberId, (room.xp.get(memberId) || 0) + amount);
}

function profileOf(room, memberId) {
  ensureParty(room);
  const xp = room.xp.get(memberId) || 0;
  const level = levelFor(xp);
  const { games = 0, wins = 0 } = room.stats.get(memberId) || {};
  return {
    xp,
    level,
    rank: rankFor(level),
    levelStart: xpForLevel(level),
    nextLevel: xpForLevel(level + 1),
    games,
    wins,
    winRatio: games ? Math.round((wins / games) * 100) : 0,
  };
}

// ---- history and ratings -----------------------------------------------------

function recordPlay(room, track, now) {
  ensureParty(room);
  if (!track) return;
  const last = room.history[room.history.length - 1];
  if (last && last.videoId === track.videoId && now - last.playedAt < 5000) return;
  room.history.push({ videoId: track.videoId, title: track.title, memberId: track.memberId, playedAt: now });
  if (room.history.length > HISTORY_MAX) room.history.splice(0, room.history.length - HISTORY_MAX);
  addXp(room, track.memberId, XP.trackPlayed);
}

function rate(room, { videoId, memberId, stars }) {
  ensureParty(room);
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new GameError('Give 1 to 5 stars.');
  const entry = room.history.find((h) => h.videoId === videoId);
  if (!entry) throw new GameError('You can only rate songs that have played.');
  if (!room.ratings.has(videoId)) room.ratings.set(videoId, new Map());
  const votes = room.ratings.get(videoId);
  const before = votes.get(memberId) || 0;
  votes.set(memberId, n);
  if (!before) addXp(room, memberId, XP.rateGiven);
  // The person who added the song gets XP for stars (not for rating their own).
  if (entry.memberId !== memberId) addXp(room, entry.memberId, (n - before) * XP.starReceived);
}

function ratingOf(room, videoId) {
  const votes = room.ratings && room.ratings.get(videoId);
  if (!votes || !votes.size) return { average: 0, count: 0 };
  let sum = 0;
  for (const v of votes.values()) sum += v;
  return { average: Math.round((sum / votes.size) * 10) / 10, count: votes.size };
}

// One entry per song, best rated first, then most recently played.
// `votes` maps each voter's public tag to their stars, so a browser can show its own rating.
function historyView(room, nameOf, tagOf) {
  ensureParty(room);
  const latest = new Map();
  room.history.forEach((h, i) => latest.set(h.videoId, { ...h, order: i }));
  return [...latest.values()]
    .map((h) => {
      const r = ratingOf(room, h.videoId);
      const votes = room.ratings.get(h.videoId);
      return {
        videoId: h.videoId,
        title: h.title,
        addedBy: nameOf(h.memberId),
        owner: tagOf(h.memberId),
        playedAt: h.playedAt,
        rating: r.average,
        ratings: r.count,
        votes: votes ? Object.fromEntries([...votes].map(([m, s]) => [tagOf(m), s])) : {},
        order: h.order,
      };
    })
    .sort((a, b) => b.rating - a.rating || b.order - a.order)
    .map(({ order, ...rest }) => rest);
}

// ---- mini-games --------------------------------------------------------------

const GAMES = Object.freeze({
  // Wait for GO, then tap first. Tapping before GO is a false start.
  reaction: { name: 'Quick Draw', countdownMs: 3000, minWaitMs: 1000, maxWaitMs: 3500, playMs: 4000 },
  // Tap as many times as you can.
  mash: { name: 'Tap Frenzy', countdownMs: 3000, playMs: 5000 },
});
const MAX_TAPS_PER_SECOND = 20;
const PICK_MS = 20000;

function startGame(room, { kind, players, now, rand }) {
  ensureParty(room);
  if (room.game && room.game.phase !== 'done') throw new GameError('A game is already running.');
  const ids = [...new Set(players)];
  if (!ids.length) throw new GameError('Nobody is here to play.');
  const kinds = Object.keys(GAMES);
  const k = kind && GAMES[kind] ? kind : kinds[Math.floor(rand() * kinds.length)];
  const g = GAMES[k];
  const wait = k === 'reaction' ? g.minWaitMs + Math.floor(rand() * (g.maxWaitMs - g.minWaitMs)) : 0;
  const goAt = now + g.countdownMs + wait;
  room.game = {
    kind: k,
    name: g.name,
    phase: 'playing',
    startedAt: now,
    goAt,
    endsAt: goAt + g.playMs,
    players: ids,
    results: new Map(), // memberId -> { tapAt } | { taps } | { falseStart: true }
    winner: null,
    choices: [],
    pickUntil: 0,
  };
  return room.game;
}

// A player's input during a game. Returns true when everyone is done early.
function gameInput(room, { memberId, taps, now }) {
  const game = room.game;
  if (!game || game.phase !== 'playing') throw new GameError('No game is running.');
  if (!game.players.includes(memberId)) throw new GameError('You joined after this game started.');
  if (game.kind === 'reaction') {
    if (game.results.has(memberId)) return false;
    game.results.set(memberId, now < game.goAt ? { falseStart: true } : { tapAt: now });
    return game.results.size === game.players.length;
  }
  // Tap race: the browser counts taps and reports the total; it is capped to a human pace.
  const max = Math.ceil(((game.endsAt - game.goAt) / 1000) * MAX_TAPS_PER_SECOND);
  const n = Math.max(0, Math.min(max, Math.floor(Number(taps) || 0)));
  const prev = game.results.get(memberId);
  game.results.set(memberId, { taps: Math.max(n, prev ? prev.taps : 0) });
  return false;
}

// Ends the game: picks the winner, gives XP and offers the winner their top 3 tracks.
function finishGame(room, { now, topTracks }) {
  const game = room.game;
  if (!game || game.phase !== 'playing') return false;
  let winner = null;
  if (game.kind === 'reaction') {
    let best = Infinity;
    for (const [m, r] of game.results) if (r.tapAt !== undefined && r.tapAt < best) { best = r.tapAt; winner = m; }
  } else {
    let best = 0;
    for (const [m, r] of game.results) if (r.taps > best) { best = r.taps; winner = m; }
  }
  for (const m of game.players) {
    const s = room.stats.get(m) || { games: 0, wins: 0 };
    s.games += 1;
    if (m === winner) s.wins += 1;
    room.stats.set(m, s);
    addXp(room, m, XP.gamePlayed + (m === winner ? XP.gameWon : 0));
  }
  game.winner = winner;
  game.choices = winner ? topTracks(winner).slice(0, 3) : [];
  game.phase = game.choices.length ? 'pick' : 'done';
  game.pickUntil = game.choices.length ? now + PICK_MS : 0;
  game.endedAt = now;
  return true;
}

// The winner picks one of their offered tracks. Returns the trackId to play.
function pickTrack(room, { memberId, trackId }) {
  const game = room.game;
  if (!game || game.phase !== 'pick') throw new GameError('There is nothing to pick right now.');
  if (memberId !== game.winner) throw new GameError('Only the winner picks the next song.');
  if (!game.choices.includes(trackId)) throw new GameError('Pick one of your top 3 tracks.');
  game.phase = 'done';
  return trackId;
}

function closePick(room) {
  if (room.game && room.game.phase === 'pick') room.game.phase = 'done';
}

// What players see. Member IDs are replaced by public tags.
function gameView(room, tagOf, trackTitle) {
  const game = room.game;
  if (!game) return null;
  const results = {};
  for (const [m, r] of game.results) results[tagOf(m)] = r;
  return {
    kind: game.kind,
    name: game.name,
    phase: game.phase,
    startedAt: game.startedAt,
    goAt: game.goAt,
    endsAt: game.endsAt,
    players: game.players.map(tagOf),
    results,
    winner: game.winner ? tagOf(game.winner) : null,
    choices: game.choices.map((id) => ({ id, title: trackTitle(id) })),
    pickUntil: game.pickUntil,
  };
}

// ---- saving ------------------------------------------------------------------

function serializeParty(room) {
  ensureParty(room);
  return {
    xp: Object.fromEntries(room.xp),
    stats: Object.fromEntries(room.stats),
    history: room.history,
    ratings: Object.fromEntries([...room.ratings].map(([v, m]) => [v, Object.fromEntries(m)])),
  };
}

function restoreParty(room, data = {}) {
  const num = (v) => Number.isFinite(v) && v >= 0;
  room.xp = new Map(Object.entries(data.xp || {}).filter(([, v]) => num(v)));
  room.stats = new Map(Object.entries(data.stats || {}).filter(([, v]) => v && num(v.games) && num(v.wins)));
  room.history = Array.isArray(data.history) ? data.history.slice(-HISTORY_MAX) : [];
  room.ratings = new Map(Object.entries(data.ratings || {}).map(([v, m]) => [v, new Map(Object.entries(m || {}))]));
  room.game = null;
  return room;
}

module.exports = {
  GameError,
  GAMES,
  XP,
  RANKS,
  levelFor,
  rankFor,
  ensureParty,
  addXp,
  profileOf,
  recordPlay,
  rate,
  ratingOf,
  historyView,
  startGame,
  gameInput,
  finishGame,
  pickTrack,
  closePick,
  gameView,
  serializeParty,
  restoreParty,
};
