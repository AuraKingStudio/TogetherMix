// Party corner: play history with star ratings, and quick pixel-art mini-games
// whose winner picks the next song. The host decides results; this file only
// draws them and sends the player's taps. room.js calls TMParty.render().
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let ctx = null; // { call, you, isHost, serverNow }
  let state = null;
  let taps = 0; // Tap Frenzy: taps counted locally, reported to the host
  let tappedGameAt = 0; // which game we already reacted in (Quick Draw)
  let sentFinalFor = 0;
  let lastSend = 0;
  let raf = 0;

  // ---- pixel art -------------------------------------------------------------

  // Each player gets a stable colour and a little 8x8 critter drawn from their tag.
  const SPRITE = [
    '..XXXX..',
    '.XXXXXX.',
    'XXWBXWBX',
    'XXWBXWBX',
    'XXXXXXXX',
    'XXX..XXX',
    '.XXXXXX.',
    '.X....X.',
  ];
  const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const colourOf = (tag) => `hsl(${hash(tag) % 360} 75% 62%)`;

  function drawSprite(g, x, y, size, colour, bounce) {
    const dy = bounce ? -Math.round(Math.abs(Math.sin(performance.now() / 120)) * size * 2) : 0;
    SPRITE.forEach((row, ry) => {
      [...row].forEach((cell, rx) => {
        if (cell === '.') return;
        g.fillStyle = cell === 'X' ? colour : cell === 'W' ? '#fff' : '#111';
        g.fillRect(x + rx * size, y + ry * size + dy, size, size);
      });
    });
  }

  function pixelText(g, text, x, y, px, colour) {
    g.font = `bold ${px}px "Courier New", monospace`;
    g.textAlign = 'center';
    g.fillStyle = '#000';
    g.fillText(text, x + 2, y + 2);
    g.fillStyle = colour;
    g.fillText(text, x, y);
  }

  function draw() {
    raf = 0;
    const canvas = $('game-canvas');
    if (!canvas || !state) return;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    const W = canvas.width;
    const H = canvas.height;
    const game = state.game;
    const now = ctx.serverNow();

    // Stage: night sky, stars and a checkered floor.
    g.fillStyle = '#141a33';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 24; i++) {
      g.fillStyle = (i + Math.floor(now / 400)) % 5 ? '#3a4372' : '#c9d3ff';
      g.fillRect((i * 53) % W, (i * 29) % (H - 40), 2, 2);
    }
    for (let x = 0; x < W; x += 16) {
      g.fillStyle = (x / 16) % 2 ? '#2b3a1f' : '#36492a';
      g.fillRect(x, H - 28, 16, 28);
    }

    const people = state.members;
    const playing = game && game.phase === 'playing';
    const go = playing && now >= game.goAt;
    const size = 4;
    const gap = Math.min(80, (W - 40) / Math.max(1, people.length));
    people.forEach((m, i) => {
      const x = 20 + i * gap;
      const y = H - 28 - 8 * size;
      const r = game && game.results[m.id];
      const isWinner = game && game.winner === m.id && game.phase !== 'playing';
      drawSprite(g, x, y, size, colourOf(m.id), isWinner || (go && r && r.taps));
      g.font = '10px monospace';
      g.textAlign = 'left';
      g.fillStyle = m.id === ctx.you ? '#ffe28a' : '#d7defa';
      g.fillText(m.nickname.slice(0, 9), x - 2, H - 6);
      if (r && r.falseStart) pixelText(g, 'X', x + 16, y - 6, 14, '#ff6b6b');
      if (r && r.taps !== undefined) pixelText(g, String(r.taps), x + 16, y - 6, 12, '#9cf');
      if (r && r.tapAt !== undefined) pixelText(g, `${r.tapAt - game.goAt}ms`, x + 16, y - 6, 11, '#9f9');
      if (isWinner) pixelText(g, '★', x + 16, y - 10, 16, '#ffd84a');
    });

    // Big centre message.
    let msg = 'PICK A GAME';
    let colour = '#ffffff';
    if (playing) {
      if (now < game.goAt) {
        const left = Math.ceil((game.goAt - now) / 1000);
        msg = game.kind === 'reaction' ? (left <= 1 ? 'WAIT…' : 'GET READY') : String(left);
        colour = '#ffd84a';
      } else if (now < game.endsAt) {
        msg = game.kind === 'reaction' ? 'GO! TAP!' : `TAP! ${Math.ceil((game.endsAt - now) / 1000)}`;
        colour = '#7dff9a';
      } else {
        msg = 'TIME!';
      }
    } else if (game && game.winner) {
      const w = people.find((m) => m.id === game.winner);
      msg = `${w ? w.nickname : 'Someone'} WINS!`;
      colour = '#ffd84a';
    } else if (game) {
      msg = 'NO WINNER';
    }
    pixelText(g, msg, W / 2, 42, 26, colour);

    if (playing || (game && game.phase === 'pick')) raf = requestAnimationFrame(draw);
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  // ---- input -------------------------------------------------------------------

  function tap() {
    const game = state && state.game;
    if (!game || game.phase !== 'playing' || !game.players.includes(ctx.you)) return;
    const now = ctx.serverNow();
    $('tap-btn').classList.remove('pop');
    void $('tap-btn').offsetWidth;
    $('tap-btn').classList.add('pop');
    if (game.kind === 'reaction') {
      if (tappedGameAt === game.startedAt) return;
      tappedGameAt = game.startedAt;
      ctx.call('gameInput', {});
      return;
    }
    if (now < game.goAt || now > game.endsAt) return;
    taps += 1;
    $('tap-count').textContent = String(taps);
    if (Date.now() - lastSend > 1000) {
      lastSend = Date.now();
      ctx.call('gameInput', { taps });
    }
  }

  function wire() {
    $('tap-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); tap(); });
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || !state || !state.game || state.game.phase !== 'playing') return;
      if (e.target.closest('input, textarea, select')) return;
      e.preventDefault();
      if (!e.repeat) tap();
    });
    for (const btn of document.querySelectorAll('[data-game]')) {
      btn.addEventListener('click', () => ctx.call('startGame', { kind: btn.dataset.game || null }));
    }
  }

  // ---- rendering ------------------------------------------------------------------

  function renderGame() {
    const game = state.game;
    const playing = game && game.phase === 'playing';
    const inGame = playing && game.players.includes(ctx.you);
    $('tap-btn').hidden = !inGame;
    $('tap-count').hidden = !(inGame && game.kind === 'mash');
    for (const btn of document.querySelectorAll('[data-game]')) {
      btn.disabled = Boolean(game && game.phase !== 'done') || (!ctx.isHost && state.settings.controls === 'host');
    }

    // New tap race: reset the counter and report the final count when time is up.
    if (playing && game.kind === 'mash' && sentFinalFor !== game.startedAt) {
      sentFinalFor = game.startedAt;
      taps = 0;
      $('tap-count').textContent = '0';
      setTimeout(() => ctx.call('gameInput', { taps }), Math.max(0, game.endsAt - ctx.serverNow() + 100));
    }
    $('tap-btn').textContent = playing && game.kind === 'reaction' ? 'TAP when it says GO' : 'TAP TAP TAP!';

    const pick = $('game-pick');
    pick.textContent = '';
    if (game && game.phase === 'pick') {
      const winner = state.members.find((m) => m.id === game.winner);
      if (game.winner === ctx.you) {
        const p = document.createElement('p');
        p.innerHTML = '<strong>You won!</strong> Pick the next song from your top 3:';
        pick.appendChild(p);
        for (const c of game.choices) {
          const b = document.createElement('button');
          b.className = 'btn primary';
          b.type = 'button';
          b.textContent = c.title;
          b.addEventListener('click', () => ctx.call('pickTrack', { trackId: c.id }));
          pick.appendChild(b);
        }
      } else {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = `${winner ? winner.nickname : 'The winner'} is picking the next song…`;
        pick.appendChild(p);
      }
    }
    schedule();
  }

  function stars(entry) {
    const mine = entry.votes[ctx.you] || 0;
    const wrap = document.createElement('span');
    wrap.className = 'stars';
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `star${n <= mine ? ' on' : ''}`;
      b.textContent = '★';
      b.title = `${n} star${n > 1 ? 's' : ''}`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.call('rate', { videoId: entry.videoId, stars: n });
      });
      wrap.appendChild(b);
    }
    return wrap;
  }

  function renderHistory() {
    const list = $('history');
    list.textContent = '';
    if (!state.history.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Songs show up here once they play. Rate them, and click one to play it again.';
      list.appendChild(li);
      return;
    }
    for (const h of state.history) {
      const li = document.createElement('li');
      li.className = 'history-item';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'history-play';
      play.title = 'Play this again for everyone';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = h.title;
      const meta = document.createElement('span');
      meta.className = 'muted small';
      meta.textContent = `${h.addedBy}${h.ratings ? ` · ${h.rating}★ (${h.ratings})` : ' · not rated yet'}`;
      play.append('▶ ', title, meta);
      play.addEventListener('click', () => ctx.call('replay', { videoId: h.videoId }));
      li.append(play, stars(h));
      list.appendChild(li);
    }
  }

  function renderMe() {
    const me = state.members.find((m) => m.id === ctx.you);
    if (!me) return;
    const span = Math.max(1, me.nextLevel - me.levelStart);
    const pct = Math.min(100, Math.round(((me.xp - me.levelStart) / span) * 100));
    $('me-level').textContent = `Lv ${me.level} · ${me.rank}`;
    $('me-xp').style.width = `${pct}%`;
    $('me-xp-text').textContent = `${me.xp - me.levelStart} / ${span} XP`;
    $('me-ratio').textContent = me.games ? `${me.wins}W / ${me.games} games · ${me.winRatio}% win` : 'No games yet';
  }

  let wired = false;
  window.TMParty = {
    render(nextState, nextCtx) {
      state = nextState;
      ctx = nextCtx;
      if (!$('game-canvas')) return;
      if (!wired) { wire(); wired = true; }
      renderGame();
      renderHistory();
      renderMe();
    },
  };
})();
