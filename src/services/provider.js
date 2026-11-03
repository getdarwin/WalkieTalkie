// Proveedor de cada línea del directorio ("twilio" | "zadarma"). Sin I/O.
// El default es "twilio" y NO se persiste, para que los directorios
// existentes (strings y objetos sin `provider`) sigan siendo válidos.

const PROVIDERS = ['twilio', 'zadarma'];
const DEFAULT_PROVIDER = 'twilio';

/** @param {unknown} value @returns {'twilio'|'zadarma'} */
function normalizeProvider(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return PROVIDERS.includes(v) ? v : DEFAULT_PROVIDER;
}

/** Proveedor de una entrada del directorio (string legacy u objeto). */
function entryProvider(entry) {
  return entry && typeof entry === 'object' ? normalizeProvider(entry.provider) : DEFAULT_PROVIDER;
}

function isZadarmaEntry(entry) {
  return entryProvider(entry) === 'zadarma';
}

/**
 * Arma la entrada del directorio (misma forma que usa setNumber): string si
 * solo hay nombre, '' si no hay nada, objeto en cualquier otro caso.
 */
function buildEntry({ name = '', channel = '', dtmf = '', language = '', keypressMode = '', routing = '', provider = '' } = {}) {
  const { isKeypressMode } = require('./ivrKeypress');
  const entry = {};
  if (name) entry.name = name;
  if (channel) entry.channel = channel;
  if (dtmf) entry.dtmf = dtmf;
  if (language) entry.language = language;
  if (isKeypressMode(keypressMode)) entry.keypressMode = keypressMode;
  if (routing) entry.routing = routing;
  if (normalizeProvider(provider) !== DEFAULT_PROVIDER) entry.provider = normalizeProvider(provider);

  const keys = Object.keys(entry);
  if (keys.length === 0) return '';
  if (keys.length === 1 && entry.name) return name;
  return entry;
}

module.exports = { PROVIDERS, DEFAULT_PROVIDER, normalizeProvider, entryProvider, isZadarmaEntry, buildEntry };
