// Pure helpers for provisioning lines from external automations (the n8n
// purchase flow). No I/O here so they can be unit-tested with node:test.

const MAX_FIELD_LENGTH = 80;
const { normalizeE164 } = require('./phone');

/** Trims, strips control characters and collapses whitespace. */
function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}


function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Highest sequence already used by `client` among existing line names.
 * "Acme" and "Acme - Owner" count as 1, "Acme 3 - Owner" as 3. Case-insensitive.
 * Returns 0 when the client has no lines yet.
 */
function highestSequence(client, existingNames) {
  const pattern = new RegExp(`^${escapeRegExp(client)}(?: (\\d+))?(?: - .*)?$`, 'i');
  let highest = 0;
  for (const name of existingNames) {
    const match = pattern.exec(cleanText(name));
    if (!match) continue;
    highest = Math.max(highest, match[1] ? parseInt(match[1], 10) : 1);
  }
  return highest;
}

/**
 * Builds "<Client>[ N] - <Owner>". The number is only added when the client
 * already has lines; the owner part is dropped when unknown.
 *
 * @param {{ client?: string, owner?: string }} input
 * @param {string[]} existingNames  friendly names already in the directory
 * @returns {string} '' when there is no client (caller keeps the raw number)
 */
function buildLineName({ client, owner } = {}, existingNames = []) {
  const cleanClient = cleanText(client);
  if (!cleanClient) return '';
  const cleanOwner = cleanText(owner);

  const next = highestSequence(cleanClient, existingNames) + 1;
  const base = next > 1 ? `${cleanClient} ${next}` : cleanClient;
  return cleanOwner ? `${base} - ${cleanOwner}` : base;
}

/** Friendly names from a directory map (entries are strings or { name }). */
function directoryNames(numbers) {
  return Object.values(numbers || {})
    .map((entry) => (typeof entry === 'string' ? entry : (entry && entry.name) || ''))
    .filter(Boolean);
}

module.exports = { cleanText, normalizeE164, highestSequence, buildLineName, directoryNames };
