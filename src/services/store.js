const fs = require('fs');
const path = require('path');

/**
 * Key-value storage abstraction with two backends:
 *
 *   - Upstash Redis (REST API) — used when UPSTASH_REDIS_REST_URL/TOKEN
 *     (or Vercel Marketplace KV_REST_API_URL/TOKEN) are set. Required in
 *     production on Vercel, where the filesystem is read-only.
 *   - Local JSON files under data/ — used in local development so
 *     `npm run dev` works with no Redis instance.
 *
 * All values are JSON-serialized. TTLs are honored by both backends.
 */

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const usingRedis = !!(REST_URL && REST_TOKEN);

if (!usingRedis && process.env.VERCEL) {
  console.error(
    '[store] FATAL: Running on Vercel without Upstash Redis. ' +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or add the Upstash integration). ' +
      'File-based fallback cannot persist on Vercel.'
  );
}

// ─── Redis backend (Upstash REST) ─────────────────────────────────────────────

async function redisCmd(...cmd) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`[store] Redis HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`[store] Redis: ${json.error}`);
  return json.result;
}

// ─── File backend (local development) ─────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '../../data/store');

function fileFor(key) {
  return path.join(DATA_DIR, `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

function fileRead(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
    if (raw.expiresAt && Date.now() > raw.expiresAt) {
      fs.unlinkSync(fileFor(key));
      return null;
    }
    return raw.value;
  } catch {
    return null;
  }
}

function fileWrite(key, value, ttlSeconds) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const wrapped = { value, ...(ttlSeconds ? { expiresAt: Date.now() + ttlSeconds * 1000 } : {}) };
  fs.writeFileSync(fileFor(key), JSON.stringify(wrapped, null, 2));
}

function fileDelete(key) {
  try { fs.unlinkSync(fileFor(key)); } catch {}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Reads a JSON value by key. Returns null if missing or expired. */
async function getJSON(key) {
  if (!usingRedis) return fileRead(key);
  const raw = await redisCmd('GET', key);
  return raw === null ? null : JSON.parse(raw);
}

/** Writes a JSON value, optionally with a TTL in seconds. */
async function setJSON(key, value, ttlSeconds = null) {
  if (!usingRedis) return fileWrite(key, value, ttlSeconds);
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds) args.push('EX', String(ttlSeconds));
  await redisCmd(...args);
}

/** Deletes a key. */
async function del(key) {
  if (!usingRedis) return fileDelete(key);
  await redisCmd('DEL', key);
}

/**
 * Prepends an entry to a capped list (newest first).
 * Used by the transaction log.
 */
async function listPush(key, entry, maxEntries) {
  if (!usingRedis) {
    const list = fileRead(key) || [];
    list.unshift(entry);
    fileWrite(key, list.slice(0, maxEntries));
    return;
  }
  await redisCmd('LPUSH', key, JSON.stringify(entry));
  await redisCmd('LTRIM', key, '0', String(maxEntries - 1));
}

/** Returns list entries (newest first). */
async function listRange(key, start = 0, stop = -1) {
  if (!usingRedis) {
    const list = fileRead(key) || [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }
  const raw = await redisCmd('LRANGE', key, String(start), String(stop));
  return (raw || []).map((item) => JSON.parse(item));
}

module.exports = { getJSON, setJSON, del, listPush, listRange, usingRedis };
