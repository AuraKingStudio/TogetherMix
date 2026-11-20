'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rooms = require('./room');

const DAY_MS = 86_400_000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// In-memory rooms, saved to a JSON file so a restart does not drop the group's mixes.
class RoomStore {
  constructor({ file, idleDays = 30, now = Date.now }) {
    this.file = file;
    this.idleMs = idleDays * DAY_MS;
    this.now = now;
    this.rooms = new Map();
    this.secret = crypto.randomBytes(32).toString('hex');
    this.saveTimer = null;
    this.dirty = false;
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (typeof data.secret === 'string' && /^[0-9a-f]{64}$/.test(data.secret)) {
      this.secret = data.secret;
    }
    for (const entry of data.rooms || []) {
      const room = rooms.restoreRoom(entry);
      this.rooms.set(room.id, room);
    }
  }

  get(id) {
    if (!rooms.isValidRoomId(id)) return null;
    return this.rooms.get(id) || null;
  }

  create({ name, settings, memberId }) {
    if (this.rooms.size >= rooms.LIMITS.maxRooms) {
      throw new rooms.RoomError('The server is full right now. Try again later.');
    }
    let id;
    do {
      id = rooms.newRoomId();
    } while (this.rooms.has(id));

    const hostToken = crypto.randomBytes(24).toString('base64url');
    const room = rooms.createRoom({
      id,
      name: rooms.cleanRoomName(name),
      settings: rooms.sanitizeSettings(settings),
      hostMemberId: memberId,
      hostTokenHash: hashToken(hostToken),
      now: this.now(),
    });
    this.rooms.set(id, room);
    this.markDirty();
    return { room, hostToken };
  }

  verifyHost(room, token) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const a = Buffer.from(hashToken(token), 'hex');
    const b = Buffer.from(room.hostTokenHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Opaque, stable per-server tag for a memberId. Clients never see raw memberIds,
  // so one person cannot act as another by copying an ID from the page.
  ownerTag(memberId) {
    return crypto.createHmac('sha256', this.secret).update(memberId).digest('base64url').slice(0, 16);
  }

  markDirty() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
    this.saveTimer.unref();
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const data = {
        version: 1,
        secret: this.secret,
        rooms: [...this.rooms.values()].map(rooms.serializeRoom),
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      console.error('Could not save rooms:', err.message);
    }
  }

  // Removes rooms nobody has touched for `idleDays` and nobody is in.
  sweep() {
    const cutoff = this.now() - this.idleMs;
    let removed = 0;
    for (const room of this.rooms.values()) {
      if (room.online.size === 0 && room.lastActivity < cutoff) {
        this.rooms.delete(room.id);
        removed++;
      }
    }
    if (removed) this.markDirty();
    return removed;
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = true;
    this.save();
  }
}

module.exports = { RoomStore };
