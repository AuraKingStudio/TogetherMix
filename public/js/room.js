(() => {
  'use strict';

  const TM = window.TM;
  const $ = (id) => document.getElementById(id);
  // Server version: /r/<id>. Static (GitHub Pages) version: room.html#<id>.
  const roomMatch = location.pathname.match(/^\/r\/([a-z0-9]{10})\/?$/i)
    || location.hash.match(/^#([a-z0-9]{10})$/i);
  const roomId = roomMatch ? roomMatch[1].toLowerCase() : null;

  // Player state values. The global `YT` is the YouTube API object, so this must not shadow it.
  const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const DRIFT_SECONDS = 1.5;
  const SUPPRESS_MS = 1200;

  let socket = null;
  let state = null; // latest server snapshot
  let you = null; // our opaque member tag
  let isHost = false;
  let clockOffset = 0; // serverTime - localTime, ms
  let player = null;
  let apiLoaded = false;
  let playerReady = false;
  let loadedTrackId = null;
  let suppressUntil = 0; // ignore YouTube events we caused ourselves
  let scrubbing = false;
  let tickCount = 0;

  if (!roomId) {
    showFatal('This invite link is not valid.');
    return;
  }

  $('nick-input').value = TM.nickname();
  $('enter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const nickname = $('nick-input').value.trim() || 'Guest';
    TM.setNickname(nickname);
    $('gate').hidden = true;
    enter();
  });

  $('play-btn').addEventListener('click', () => {
    if (!state) return;
    call('control', { action: state.playback.playing ? 'pause' : 'play' });
  });
  $('skip-btn').addEventListener('click', () => call('control', { action: 'skip' }));
  $('sync-btn').addEventListener('click', () => {
    syncPlayer(true);
    TM.toast('Back in sync');
  });
  $('seek').addEventListener('input', () => { scrubbing = true; });
  $('seek').addEventListener('change', (event) => {
    scrubbing = false;
    call('control', { action: 'seek', position: Number(event.target.value) });
  });
  // Room volume is shared: moving it changes the volume for everyone, live.
  // While you drag (and shortly after), updates from the room must not move the
  // slider back, or it fights your finger and jumps around.
  let volumeTimer = null;
  let volumeTouchedAt = 0;
  const showVolume = (v) => {
    $('volume').value = String(v);
    $('volume').style.setProperty('--fill', `${v}%`);
    $('volume-pct').textContent = `${v}%`;
  };
  $('volume').addEventListener('input', (event) => {
    const volume = Number(event.target.value);
    volumeTouchedAt = Date.now();
    showVolume(volume);
    if (playerReady) player.setVolume(volume);
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => call('control', { action: 'volume', volume }), 150);
  });
  $('add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('add-url');
    const url = input.value.trim();
    if (!url) return;
    $('add-btn').disabled = true;
    const res = await call('addTrack', { url });
    if (res.ok) {
      input.value = '';
      if (res.message) TM.toast(res.message);
    }
    if (state) renderControls();
  });
  // Pasting a link adds it straight away: no need to find the Add button.
  $('add-url').addEventListener('paste', () => {
    setTimeout(() => {
      if ($('add-url').value.trim()) $('add-form').requestSubmit();
    }, 0);
  });
  $('pool').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'select') {
      call('control', { action: 'select', trackId: button.dataset.id });
    } else if (button.dataset.action === 'remove') {
      call('removeTrack', { trackId: button.dataset.id });
    }
  });
  $('copy-link').addEventListener('click', async () => {
    const link = TM.inviteLink(roomId);
    // Phones: open the share sheet (WhatsApp, Discord, Messages…). Cancelling it is fine.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'Join my TogetherMix room', url: link });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      TM.toast('Invite link copied');
    } catch {
      window.prompt('Copy the invite link:', link);
    }
  });
  $('rename-btn').addEventListener('click', () => {
    const name = window.prompt('Your nickname in this room:', TM.nickname());
    if (!name || !name.trim()) return;
    TM.setNickname(name.trim());
    if (socket && socket.connected) join();
  });
  $('settings-btn').addEventListener('click', () => {
    if (!state) return;
    TM.renderSettingsFields($('settings-fields'), state.settings);
    $('settings-dialog').showModal();
  });
  $('settings-cancel').addEventListener('click', () => $('settings-dialog').close());
  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const settings = TM.readSettingsFields($('settings-fields'));
    const res = await call('updateSettings', { settings });
    if (res.ok) {
      $('settings-dialog').close();
      TM.toast('Settings saved');
    }
  });

  TM.initAds();
  setInterval(tick, 500);

  // ---- connection ---------------------------------------------------------

  function enter() {
    loadYouTubeApi();
    socket = io();
    socket.on('connect', join);
    socket.on('disconnect', () => setStatus('Reconnecting…', 'warn'));
    socket.on('state', onState);
  }

  async function join() {
    setStatus('Connecting…', 'warn');
    try {
      await syncClock();
      const res = await socket.timeout(8000).emitWithAck('join', {
        roomId,
        memberId: TM.memberId(),
        nickname: TM.nickname() || 'Guest',
        hostToken: TM.hostToken(roomId) || undefined,
      });
      if (!res.ok) {
        showFatal(res.error);
        return;
      }
      you = res.you;
      isHost = res.isHost;
      setStatus(isHost ? 'Live · you host' : 'Live', 'ok');
      onState(res.state);
    } catch {
      setStatus('Connection problem…', 'warn');
    }
  }

  // Averages the lowest-latency round trip so the server clock can be estimated.
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const res = await socket.timeout(4000).emitWithAck('ping');
      const t1 = Date.now();
      if (!res || typeof res.serverNow !== 'number') continue;
      const rtt = t1 - t0;
      const offset = res.serverNow - (t0 + t1) / 2;
      if (!best || rtt < best.rtt) best = { rtt, offset };
    }
    if (best) clockOffset = best.offset;
  }

  const serverNow = () => Date.now() + clockOffset;

  // Sends an event and reports failures to the user. Control failures also
  // re-sync the local player so it matches what the room actually does.
  async function call(event, payload) {
    if (!socket) return { ok: false, error: 'Not connected yet.' };
    let res;
    try {
      res = await socket.timeout(10000).emitWithAck(event, payload);
    } catch {
      res = { ok: false, error: 'No response from the server. Check your connection.' };
    }
    if (!res.ok) {
      TM.toast(res.error, true);
      if (event === 'control') syncPlayer(true);
    }
    return res;
  }

  function onState(next) {
    state = next;
    render();
    syncPlayer(false);
  }

  function showFatal(message) {
    if (socket) socket.disconnect();
    $('gate').hidden = true;
    $('fatal-message').textContent = message;
    $('fatal').hidden = false;
  }

  function setStatus(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = `chip status ${kind || ''}`;
  }

  // ---- YouTube player -----------------------------------------------------

  function loadYouTubeApi() {
    if (apiLoaded) return;
    apiLoaded = true;
    window.onYouTubeIframeAPIReady = createPlayer;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => TM.toast('YouTube could not load. Check your connection or ad blocker.', true);
    document.head.appendChild(script);
  }

  function createPlayer() {
    if (player) return;
    player = new window.YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => {
          playerReady = true;
          syncPlayer(true);
        },
        onStateChange: onPlayerState,
        onError: onPlayerError,
      },
    });
  }

  function suppressEvents() {
    suppressUntil = Date.now() + SUPPRESS_MS;
  }

  function expectedPosition() {
    const pb = state.playback;
    const elapsed = pb.playing ? (serverNow() - state.serverNow) / 1000 : 0;
    return Math.max(0, pb.position + elapsed);
  }

  // Makes the local player match the room state: load, play/pause, and seek when drifting.
  function syncPlayer(force) {
    if (!state || !playerReady) return;
    if (Date.now() - volumeTouchedAt > 1500) {
      const volume = state.playback.volume ?? 80;
      if (Number($('volume').value) !== volume) showVolume(volume);
      if (player.getVolume() !== volume) player.setVolume(volume);
    }
    const pb = state.playback;

    if (pb.trackId !== loadedTrackId) {
      loadedTrackId = pb.trackId;
      suppressEvents();
      if (!pb.trackId) {
        player.stopVideo();
        return;
      }
      const track = state.tracks.find((t) => t.id === pb.trackId);
      if (!track) return;
      const start = expectedPosition();
      if (pb.playing) player.loadVideoById({ videoId: track.videoId, startSeconds: start });
      else player.cueVideoById({ videoId: track.videoId, startSeconds: start });
      return;
    }
    if (!loadedTrackId) return;

    const ps = player.getPlayerState();
    const live = ps === PS.PLAYING || ps === PS.PAUSED || ps === PS.BUFFERING;

    if (pb.playing && ps !== PS.PLAYING && ps !== PS.BUFFERING && ps !== PS.ENDED) {
      suppressEvents();
      player.playVideo();
    } else if (!pb.playing && (ps === PS.PLAYING || ps === PS.BUFFERING)) {
      suppressEvents();
      player.pauseVideo();
    }

    if (!live) return;
    const expected = expectedPosition();
    if (force || Math.abs(player.getCurrentTime() - expected) > DRIFT_SECONDS) {
      suppressEvents();
      player.seekTo(expected, true);
    }
  }

  // Forwards the user's native player actions (YouTube's own controls) to the room.
  function onPlayerState(event) {
    if (!state || !loadedTrackId) return;
    if (event.data === PS.ENDED) {
      socket.emit('ended', { trackId: loadedTrackId });
      return;
    }
    if (Date.now() < suppressUntil) return;
    const shouldPlay = state.playback.playing;
    if (event.data === PS.PLAYING && !shouldPlay) {
      call('control', { action: 'play', position: player.getCurrentTime() });
    } else if (event.data === PS.PAUSED && shouldPlay) {
      call('control', { action: 'pause', position: player.getCurrentTime() });
    }
  }

  function onPlayerError() {
    if (!loadedTrackId) return;
    socket.emit('broken', { trackId: loadedTrackId });
    TM.toast('That video cannot be played here. Skipping it.', true);
  }

  function tick() {
    if (!state) return;
    renderTime();
    if (playerReady && ++tickCount % 4 === 0) syncPlayer(false);
  }

  function renderTime() {
    const active = playerReady && loadedTrackId;
    const current = active ? player.getCurrentTime() || 0 : 0;
    const duration = active ? player.getDuration() || 0 : 0;
    if (!scrubbing && duration > 0) {
      $('seek').max = String(duration);
      $('seek').value = String(current);
    }
    $('time').textContent = `${TM.formatTime(current)} / ${TM.formatTime(duration)}`;
  }

  // ---- rendering ----------------------------------------------------------

  function render() {
    const s = state;
    $('room-name').textContent = s.name;
    document.title = `${s.name} · TogetherMix`;
    $('rules').textContent = describeRules(s);
    renderMembers();
    renderNowPlaying();
    renderPool();
    renderControls();
    applyMood();
    if (window.TMParty) window.TMParty.render(state, { call, you, isHost, serverNow });
  }

  // The background pulses while music plays. YouTube's audio can't be read from
  // the page, so tempo and colour come from the genre guessed from the title.
  const GENRES = [
    [/lo-?fi|chill|ambient|sleep|study|relax/i, 'chill', 72, 265],
    [/jazz|soul|r&b|rnb|blues/i, 'soul', 88, 30],
    [/hip ?hop|rap|trap|drill/i, 'hip hop', 92, 285],
    [/phonk/i, 'phonk', 130, 320],
    [/drum ?(and|&|n) ?bass|dnb|jungle/i, 'drum & bass', 172, 190],
    [/house|techno|edm|trance|dance|remix|club/i, 'electronic', 126, 200],
    [/metal|core\b/i, 'metal', 150, 0],
    [/rock|punk|grunge/i, 'rock', 124, 15],
    [/k-?pop|j-?pop|pop/i, 'pop', 116, 330],
    [/classical|piano|orchestra|symphony/i, 'classical', 66, 45],
    [/reggae|afro|latin|reggaeton|salsa/i, 'world', 98, 140],
  ];
  function applyMood() {
    const s = state;
    const track = s.tracks.find((t) => t.id === s.playback.trackId);
    const match = track && GENRES.find(([re]) => re.test(track.title));
    const [, genre, bpm, hue] = match || [null, 'music', 110, 228];
    const root = document.documentElement.style;
    root.setProperty('--beat', `${(60 / bpm).toFixed(3)}s`);
    root.setProperty('--mood-hue', String(hue));
    document.body.classList.toggle('is-playing', Boolean(track && s.playback.playing));
    $('genre').textContent = track ? `${genre} · ~${bpm} bpm` : '';
  }

  function describeRules(s) {
    const st = s.settings;
    const parts = [];
    parts.push({ 'round-robin': 'Turns between mixes', shuffle: 'Shuffled', added: 'In the order added', mix: 'Auto mix by % share' }[st.order]);
    if (st.maxPerMember) parts.push(`max ${st.maxPerMember} per person`);
    if (st.addPolicy === 'host') parts.push('only the host adds');
    if (st.controls === 'host') parts.push('only the host controls playback');
    parts.push(st.skipMode === 'vote'
      ? `skip by vote (${Math.round(st.voteRatio * 100)}% online)`
      : 'instant skip');
    if (st.loop) parts.push('loops');
    if (st.locked) parts.push('pool locked');
    return parts.join(' · ');
  }

  function renderMembers() {
    const list = $('members');
    list.textContent = '';
    // Auto mix: show each person's chance that their track plays next.
    const mix = state.settings.order === 'mix';
    const total = state.members.reduce((sum, m) => sum + (m.share ?? 50), 0);
    for (const m of state.members) {
      let label = `${m.nickname}${m.isHost ? ' · host' : ''} · Lv ${m.level || 1}`;
      if (mix) label += ` · ${total ? Math.round(((m.share ?? 50) / total) * 100) : 0}%`;
      const chip = el('li', `chip${m.id === you ? ' me' : ''}${mix && isHost ? ' clickable' : ''}`, label);
      if (mix && isHost) {
        chip.title = 'Click to change how often their tracks get picked';
        chip.addEventListener('click', () => {
          const answer = window.prompt(`Share for ${m.nickname} (0 = never, 100 = most often):`, String(m.share ?? 50));
          if (answer === null) return;
          call('setShare', { member: m.id, share: Number(answer) });
        });
      }
      list.appendChild(chip);
    }
  }

  function renderNowPlaying() {
    const s = state;
    const track = s.tracks.find((t) => t.id === s.playback.trackId);
    if (track) {
      $('now-title').textContent = track.title;
      $('now-by').textContent = `Added by ${track.addedBy}`;
    } else if (!s.tracks.length) {
      $('now-title').textContent = 'The pool is empty';
      $('now-by').textContent = 'Add the first track to start the mix.';
    } else {
      $('now-title').textContent = 'Pool finished';
      $('now-by').textContent = 'Press Play to start it again.';
    }
  }

  function renderPool() {
    const s = state;
    const list = $('pool');
    list.textContent = '';

    const mine = s.tracks.filter((t) => t.owner === you).length;
    const cap = s.settings.maxPerMember;
    $('quota').textContent = cap > 0 ? `Your tracks: ${mine} / ${cap}` : mine ? `Your tracks: ${mine}` : '';

    if (!s.tracks.length) {
      list.appendChild(el('li', 'empty', 'No tracks yet. Paste a YouTube link above.'));
      return;
    }

    const canControl = isHost || s.settings.controls === 'everyone';
    s.tracks.forEach((t, i) => {
      const li = el('li', `track${t.id === s.playback.trackId ? ' current' : ''}${t.broken ? ' broken' : ''}`);
      const info = el('div', 'track-info');
      info.append(
        el('span', 'track-title', t.title),
        el('span', 'track-meta', `${t.addedBy}${t.broken ? ' · unavailable' : ''}`),
      );
      const actions = el('div', 'track-actions');
      if (canControl && !t.broken && t.id !== s.playback.trackId) {
        actions.appendChild(actionButton('Play', 'select', t.id));
      }
      if (t.owner === you || isHost) {
        actions.appendChild(actionButton('Remove', 'remove', t.id));
      }
      li.append(el('span', 'track-num', String(i + 1)), info, actions);
      list.appendChild(li);
    });
  }

  function renderControls() {
    const s = state;
    const canControl = isHost || s.settings.controls === 'everyone';
    const hasTrack = Boolean(s.playback.trackId);
    const voting = !isHost && s.settings.skipMode === 'vote';

    $('play-btn').textContent = s.playback.playing ? 'Pause' : 'Play';
    $('play-btn').disabled = !canControl || (!hasTrack && !s.tracks.length);
    $('skip-btn').disabled = !canControl || !hasTrack;
    $('skip-btn').textContent = voting && hasTrack ? `Vote skip (${s.skip.votes}/${s.skip.needed})` : 'Skip';
    $('seek').disabled = !canControl || !hasTrack;
    $('sync-btn').disabled = !hasTrack;

    const addAllowed = !s.settings.locked && (s.settings.addPolicy === 'everyone' || isHost);
    $('add-url').disabled = !addAllowed;
    $('add-btn').disabled = !addAllowed;
    $('add-url').placeholder = addAllowed
      ? 'Paste a YouTube link here'
      : s.settings.locked ? 'The pool is locked' : 'Only the host can add tracks';

    $('settings-btn').hidden = !isHost;
  }

  function actionButton(text, action, id) {
    const button = el('button', 'btn small', text);
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.id = id;
    return button;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
})();
