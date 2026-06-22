/**
 * SemanticCache — LLM-powered query similarity cache for Shopify product search.
 *
 * Flow:
 *   1. get(query)  → calls GPT to check if any cached query is semantically similar
 *                    Returns cached result if similarity >= threshold, else null
 *   2. set(query, result) → stores result under the raw query string with a TTL
 *   3. purge()     → removes expired entries (called lazily on every get/set)
 */

const axios = require("axios");
require("dotenv").config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30 * 60 * 1000;
const CACHE_SIMILARITY_THRESHOLD =
  Number(process.env.CACHE_SIMILARITY_THRESHOLD) || 0.82;
const CACHE_MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 200;

class SemanticCache {
  /**
   * @param {object} opts
   * @param {string}  opts.openaiApiKey     - OpenAI API key
   * @param {string}  [opts.model]          - Chat model to use (default: gpt-4.1-mini)
   * @param {number}  [opts.ttlMs]          - Cache TTL in milliseconds (default: 30 min)
   * @param {number}  [opts.similarityThreshold] - 0-1 score above which queries are "same" (default: 0.82)
   * @param {number}  [opts.maxEntries]     - Max cached entries before oldest are evicted (default: 200)
   */
  constructor(opts = {}) {
    this.openaiApiKey = opts.openaiApiKey;
    this.model = opts.model || "gpt-4.1-mini";
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000; // 30 minutes
    this.similarityThreshold = opts.similarityThreshold ?? 0.82;
    this.maxEntries = opts.maxEntries ?? 200;

    // Map<string, { result: any, expiresAt: number }>
    this._store = new Map();

    console.log(
      `[SemanticCache] Initialized — TTL: ${this.ttlMs / 1000}s | ` +
        `Threshold: ${this.similarityThreshold} | Model: ${this.model}`,
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Look up a query. Returns cached result if a semantically similar query
   * is found, otherwise returns null.
   * @param {string} query
   * @returns {Promise<any|null>}
   */
  async get(query) {
    this._purgeExpired();

    const keys = [...this._store.keys()];
    if (keys.length === 0) return null;

    let matchedKey;
    const exactMatchPrefixes = [
      "product:",
      "get_products_sorted:",
      "store_metadata",
      "available_discounts",
      "filter_by_",
    ];

    const isExactMatch = exactMatchPrefixes.some(
      (prefix) => query.startsWith(prefix) || query.includes(prefix),
    );

    if (isExactMatch) {
      matchedKey = query;
    } else {
      matchedKey = await this._findSimilarQuery(query, keys);
      if (!matchedKey) return null;
    }

    const entry = this._store.get(matchedKey);
    if (!entry || Date.now() > entry.expiresAt) {
      this._store.delete(matchedKey);
      return null;
    }

    console.log(
      `[SemanticCache] HIT — "${query}" matched cached key "${matchedKey}"`,
    );
    return entry.result;
  }

  /**
   * Store a result under the given query string.
   * @param {string} query
   * @param {any}    result
   */
  set(query, result, ttlMsOverride = null) {
    this._purgeExpired();
    this._evictIfFull();

    const ttl = ttlMsOverride ?? this.ttlMs;
    this._store.set(query, {
      result,
      expiresAt: Date.now() + ttl,
    });

    console.log(
      `[SemanticCache] SET — "${query}" (${this._store.size} entries in cache)`,
    );
  }

  /** Current number of (non-expired) entries. */
  get size() {
    this._purgeExpired();
    return this._store.size;
  }

  /** Wipe the entire cache (useful in tests / admin resets). */
  clear() {
    this._store.clear();
    console.log("[SemanticCache] Cache cleared.");
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Ask GPT to find the most semantically similar cached query.
   * Returns the matched key string, or null if nothing is similar enough.
   * @param {string}   newQuery
   * @param {string[]} cachedKeys
   * @returns {Promise<string|null>}
   */
  async _findSimilarQuery(newQuery, cachedKeys) {
    try {
      const prompt = `You are a semantic similarity judge for an eCommerce product search cache.

Given a NEW search query and a list of CACHED queries, decide which cached query (if any) is semantically similar enough to the new query that the same product results would satisfy both.

Rules:
- Consider queries similar if they express the same product intent (e.g. "red shoes" ≈ "shoes in red", "sofa" ≈ "couch", "budget phone" ≈ "cheap smartphone").
- Ignore minor wording differences, plurals, and word order if the intent is the same.
- Do NOT match if the product type or key attributes differ (e.g. "red shoes" ≠ "blue shoes", "gaming laptop" ≠ "office laptop").
- Return ONLY valid JSON — no markdown, no explanation.

Response format (exactly one of):
{ "matched": true, "key": "<exact cached query string>", "score": <0.0-1.0> }
{ "matched": false }

NEW query: "${newQuery.replace(/"/g, '\\"')}"

CACHED queries:
${cachedKeys.map((k, i) => `${i + 1}. "${k.replace(/"/g, '\\"')}"`).join("\n")}`;

      const response = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 80,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.openaiApiKey}`,
          },
          timeout: 8000,
        },
      );

      const raw = response?.data?.choices?.[0]?.message?.content?.trim() || "";
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (
        parsed?.matched === true &&
        typeof parsed.key === "string" &&
        (parsed.score ?? 1) >= this.similarityThreshold &&
        this._store.has(parsed.key)
      ) {
        return parsed.key;
      }

      return null;
    } catch (err) {
      // Cache miss on any error — fall through to fresh API call
      console.warn("[SemanticCache] Similarity check failed:", err.message);
      return null;
    }
  }

  /** Remove all entries past their TTL. */
  _purgeExpired() {
    const now = Date.now();
    for (const [key, entry] of this._store.entries()) {
      if (now > entry.expiresAt) {
        this._store.delete(key);
        console.log(`[SemanticCache] EXPIRED — "${key}"`);
      }
    }
  }

  /** Evict the oldest entry when the cache is full. */
  _evictIfFull() {
    if (this._store.size >= this.maxEntries) {
      const oldestKey = this._store.keys().next().value;
      this._store.delete(oldestKey);
      console.log(`[SemanticCache] EVICTED (capacity) — "${oldestKey}"`);
    }
  }
}

const defaultCache = new SemanticCache({
  openaiApiKey: OPENAI_API_KEY,
  model: OPENAI_MODEL,
  ttlMs: CACHE_TTL_MS,
  similarityThreshold: CACHE_SIMILARITY_THRESHOLD,
  maxEntries: CACHE_MAX_ENTRIES,
});

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
  SemanticCache,
  getCache,
  setCache,
  clearCache,
};
