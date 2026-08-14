/**
 * Cache — Simple in-memory query cache for Shopify product search.
 *
 * Flow:
 *   1. get(key)  → returns cached result if the exact key exists and is not expired
 *   2. set(key, result) → stores result under the key with a TTL
 *   3. purge()   → removes expired entries (called lazily on every get/set)
 */

require("dotenv").config();

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 200;

class Cache {
  /**
   * @param {object} opts
   * @param {number} [opts.ttlMs] - Cache TTL in milliseconds (default: 30 min)
   * @param {number} [opts.maxEntries] - Max cached entries before oldest are evicted
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 200;

    // Map<string, { result: any, expiresAt: number }>
    this._store = new Map();

    console.log(
      `[Cache] Initialized — TTL: ${this.ttlMs / 1000}s | ` +
        `Max Entries: ${this.maxEntries}`,
    );
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Look up a cached value by exact key.
   *
   * @param {string} key
   * @returns {Promise<any|null>}
   */
  async get(key) {
    this._purgeExpired();

    if (!key) {
      return null;
    }

    const entry = this._store.get(key);

    if (!entry) {
      console.log(`[Cache] MISS — "${key}"`);
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);

      console.log(`[Cache] EXPIRED — "${key}"`);

      return null;
    }

    console.log(`[Cache] HIT — "${key}"`);

    return entry.result;
  }

  /**
   * Store a result under the given key.
   *
   * @param {string} key
   * @param {any} result
   * @param {number|null} ttlMsOverride
   */
  set(key, result, ttlMsOverride = null) {
    if (!key) {
      return;
    }

    this._purgeExpired();

    // If key already exists, update it without evicting another entry.
    if (!this._store.has(key)) {
      this._evictIfFull();
    }

    const ttl = ttlMsOverride ?? this.ttlMs;

    this._store.set(key, {
      result,
      expiresAt: Date.now() + ttl,
    });

    console.log(
      `[Cache] SET — "${key}" (${this._store.size} entries in cache)`,
    );
  }

  /**
   * Current number of non-expired entries.
   */
  get size() {
    this._purgeExpired();

    return this._store.size;
  }

  /**
   * Wipe the entire cache.
   */
  clear() {
    this._store.clear();

    console.log("[Cache] Cache cleared.");
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Remove all entries past their TTL.
   */
  _purgeExpired() {
    const now = Date.now();

    for (const [key, entry] of this._store.entries()) {
      if (now > entry.expiresAt) {
        this._store.delete(key);

        console.log(`[Cache] EXPIRED — "${key}"`);
      }
    }
  }

  /**
   * Evict the oldest entry when the cache is full.
   */
  _evictIfFull() {
    if (this._store.size < this.maxEntries) {
      return;
    }

    const oldestKey = this._store.keys().next().value;

    if (oldestKey !== undefined) {
      this._store.delete(oldestKey);

      console.log(`[Cache] EVICTED (capacity) — "${oldestKey}"`);
    }
  }
}

// ─── Default Cache ────────────────────────────────────────────────────────────

const defaultCache = new Cache({
  ttlMs: CACHE_TTL_MS,
  maxEntries: CACHE_MAX_ENTRIES,
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

async function getCache(key) {
  return defaultCache.get(key);
}

async function setCache(key, value, ttlSeconds = null) {
  const ttlMs = ttlSeconds !== null ? Number(ttlSeconds) * 1000 : null;

  return defaultCache.set(key, value, ttlMs);
}

function clearCache() {
  return defaultCache.clear();
}

module.exports = {
  Cache,
  getCache,
  setCache,
  clearCache,
};
