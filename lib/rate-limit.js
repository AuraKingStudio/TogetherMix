'use strict';

// Sliding-window limiter keyed by IP address or socket id.
function createKeyedLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    allow(key) {
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 50000) hits.clear();
      return true;
    },
    forget(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createKeyedLimiter };
