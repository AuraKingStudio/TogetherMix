(() => {
  'use strict';

  const TM = window.TM;
  const $ = (id) => document.getElementById(id);

  TM.renderSettingsFields($('settings-fields'), TM.DEFAULT_SETTINGS);
  $('nickname').value = TM.nickname();
  TM.initAds();

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('create-error');
    const button = $('create-btn');
    error.hidden = true;

    const nickname = $('nickname').value.trim() || 'Guest';
    const name = $('room-name').value.trim() || `${nickname}'s room`;
    TM.setNickname(nickname);

    button.disabled = true;
    try {
      const data = await TM.postJson('/api/rooms', {
        name,
        memberId: TM.memberId(),
        settings: TM.readSettingsFields($('settings-fields')),
      });
      TM.saveHostToken(data.id, data.hostToken);
      location.href = `/r/${data.id}`;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
    }
  });

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const error = $('join-error');
    const value = $('join-input').value.trim();
    const match = value.match(/\/r\/([a-z0-9]{10})\b/i) || value.match(/^([a-z0-9]{10})$/i);
    if (!match) {
      error.textContent = 'That does not look like an invite link.';
      error.hidden = false;
      return;
    }
    location.href = `/r/${match[1].toLowerCase()}`;
  });
})();
