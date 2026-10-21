// In-memory daily request limits (per visitor and for the whole site). Resets at midnight China time.

function chinaDay(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function createLimiter({ perKey, global }) {
  let day = null;
  let total = 0;
  let counts = new Map();

  return {
    check(key, now = new Date()) {
      const today = chinaDay(now);
      if (today !== day) {
        day = today;
        total = 0;
        counts = new Map();
      }
      if (total >= global) return { ok: false, reason: "global" };
      const used = counts.get(key) || 0;
      if (used >= perKey) return { ok: false, reason: "visitor" };
      counts.set(key, used + 1);
      total++;
      return { ok: true };
    },
  };
}
