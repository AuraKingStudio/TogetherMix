(() => {
  'use strict';

  const KEY_MEMBER = 'tm.memberId';
  const KEY_NICK = 'tm.nickname';
  const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // Mirrors DEFAULT_SETTINGS in lib/room.js.
  const DEFAULT_SETTINGS = {
    addPolicy: 'everyone',
    maxPerMember: 0,
    allowDuplicates: false,
    order: 'round-robin',
    controls: 'everyone',
    skipMode: 'vote',
    voteRatio: 0.5,
    autoplay: true,
    loop: true,
    locked: false,
  };

  const SETTING_FIELDS = [
    { key: 'addPolicy', label: 'Who can add tracks', kind: 'select',
      options: [['everyone', 'Everyone'], ['host', 'Only the host']] },
    { key: 'maxPerMember', label: 'Max tracks per person (0 = no limit)', kind: 'number', min: 0, max: 200 },
    { key: 'allowDuplicates', label: 'Allow the same video more than once', kind: 'checkbox' },
    { key: 'order', label: 'Play order', kind: 'select',
      options: [['round-robin', 'Round-robin: take turns between mixes'],
                ['added', 'In the order they were added'],
                ['shuffle', 'Shuffle']] },
    { key: 'controls', label: 'Who controls playback', kind: 'select',
      options: [['everyone', 'Everyone'], ['host', 'Only the host']] },
    { key: 'skipMode', label: 'Skipping', kind: 'select',
      options: [['vote', 'Vote: needs a share of the people online'], ['instant', 'Instant']] },
    { key: 'voteRatio', label: 'Share of people online needed to skip', kind: 'select', numeric: true,
      options: [['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%']] },
    { key: 'autoplay', label: 'Play the next track automatically', kind: 'checkbox' },
    { key: 'loop', label: 'Start over when the pool ends', kind: 'checkbox' },
    { key: 'locked', label: 'Lock the pool (no new tracks)', kind: 'checkbox' },
  ];

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* private mode: keep going */ }
    },
  };

  function randomToken(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]; // 64 symbols: no bias
    return out;
  }

  function memberId() {
    let id = store.get(KEY_MEMBER);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = randomToken(22);
      store.set(KEY_MEMBER, id);
    }
    return id;
  }

  function formatTime(seconds) {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  async function postJson(url, body) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Could not reach the server. Check your connection.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function renderSettingsFields(container, values) {
    container.textContent = '';
    for (const field of SETTING_FIELDS) {
      const label = document.createElement('label');
      let input;
      if (field.kind === 'checkbox') {
        label.className = 'check';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(values[field.key]);
        label.append(input, document.createTextNode(` ${field.label}`));
      } else {
        label.className = 'field';
        const span = document.createElement('span');
        span.textContent = field.label;
        if (field.kind === 'select') {
          input = document.createElement('select');
          for (const [value, text] of field.options) input.add(new Option(text, value));
        } else {
          input = document.createElement('input');
          input.type = 'number';
          input.min = String(field.min);
          input.max = String(field.max);
          input.step = '1';
        }
        input.value = String(values[field.key]);
        label.append(span, input);
      }
      input.name = field.key;
      container.appendChild(label);
    }
  }

  function readSettingsFields(container) {
    const out = {};
    for (const field of SETTING_FIELDS) {
      const el = container.querySelector(`[name="${field.key}"]`);
      if (field.kind === 'checkbox') out[field.key] = el.checked;
      else if (field.kind === 'number' || field.numeric) out[field.key] = Number(el.value);
      else out[field.key] = el.value;
    }
    return out;
  }

  // Ads only load when ADSENSE_CLIENT and ADSENSE_SLOT are set on the server.
  // Ad boxes stay hidden otherwise, so the layout stays clean during setup.
  function initAds() {
    const cfg = window.TOGETHERMIX_CONFIG || {};
    const boxes = document.querySelectorAll('[data-ad-slot-box]');
    if (!/^ca-pub-\d{10,20}$/.test(cfg.adsenseClient || '') || !/^\d{6,20}$/.test(cfg.adsenseSlot || '')) {
      return;
    }
    boxes.forEach((box) => {
      box.hidden = false;
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.dataset.adClient = cfg.adsenseClient;
      ins.dataset.adSlot = cfg.adsenseSlot;
      ins.dataset.adFormat = 'auto';
      ins.dataset.fullWidthResponsive = 'true';
      box.querySelector('.ad-inner').appendChild(ins);
    });
    const script = document.createElement('script');
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(cfg.adsenseClient)}`;
    document.head.appendChild(script);
    boxes.forEach(() => {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    });
  }

  window.TM = {
    DEFAULT_SETTINGS,
    memberId,
    nickname: () => store.get(KEY_NICK) || '',
    setNickname: (name) => store.set(KEY_NICK, name),
    hostToken: (roomId) => store.get(`tm.host.${roomId}`),
    saveHostToken: (roomId, token) => store.set(`tm.host.${roomId}`, token),
    formatTime,
    toast,
    postJson,
    renderSettingsFields,
    readSettingsFields,
    initAds,
  };
})();
