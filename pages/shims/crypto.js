'use strict';

// Browser stand-in for the two node:crypto calls lib/room.js uses.

function randomInt(max) {
  // Rejection sampling keeps the result unbiased.
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return {
    toString(encoding) {
      if (encoding !== 'base64url') throw new Error('Only base64url is supported');
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
  };
}

module.exports = { randomInt, randomBytes };
