// Home page for the static build: rooms are created in this browser, which becomes the host.
function startHome() {
  'use strict';

  const TM = window.TM;
  const $ = (id) => document.getElementById(id);

  TM.renderSettingsFields($('settings-fields'), TM.DEFAULT_SETTINGS);
  $('nickname').value = TM.nickname();
  TM.initAds();

  const openRoom = (id) => {
    location.hash = id;
    location.reload();
  };

  $('create-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const error = $('create-error');
    error.hidden = true;
    const nickname = $('nickname').value.trim() || 'Guest';
    TM.setNickname(nickname);
    try {
      const { id, hostToken } = window.TMP2P.createLocalRoom({
        name: $('room-name').value.trim(),
        settings: TM.readSettingsFields($('settings-fields')),
        memberId: TM.memberId(),
      });
      TM.saveHostToken(id, hostToken);
      openRoom(id);
    } catch (err) {
      error.textContent = err.message || 'Could not create the room.';
      error.hidden = false;
    }
  });

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const error = $('join-error');
    const value = $('join-input').value.trim();
    const match = value.match(/#([a-z0-9]{10})\b/i) || value.match(/\/r\/([a-z0-9]{10})\b/i) || value.match(/^([a-z0-9]{10})$/i);
    if (!match) {
      error.textContent = 'That does not look like an invite link.';
      error.hidden = false;
      return;
    }
    openRoom(match[1].toLowerCase());
  });
}
