/**
 * Detects "press <key>" instructions inside a live IVR transcript.
 *
 * Meta's WhatsApp verification IVR gates the call behind an anti-bot keypress
 * and the requested digit changes between calls ("press 9", "presione el 0",
 * "aperte a tecla oito"). This module turns a transcript fragment into the
 * DTMF key to send, or null when the text contains no such instruction.
 *
 * Detection is deliberately strict — an instruction verb must precede the key
 * within a few words — so spoken verification codes ("your code is 1 6 9 4")
 * never trigger a keypress.
 */

// Verbs (EN / ES / PT) that introduce a keypress instruction. Text is
// lowercased and stripped of diacritics before matching, so entries here are
// plain ASCII.
const INSTRUCTION_VERBS = [
  // EN
  'press', 'hit', 'select', 'choose',
  // ES — includes voseo/imperative variants; accents are stripped before matching
  'presione', 'presiona', 'presionar', 'oprima', 'oprime', 'oprimi', 'oprimir',
  'pulse', 'pulsa', 'pulsar', 'marque', 'marca', 'marcar',
  'aprieta', 'apriete', 'apreta', 'apretar',
  'digite', 'digita', 'teclee', 'teclea', 'tecle', 'toca', 'toque', 'selecciona', 'seleccione',
  // PT
  'pressione', 'pressiona', 'aperte', 'aperta', 'prima', 'carregue', 'digitar', 'escolha',
];

// Spoken forms of each DTMF key.
const KEY_WORDS = {
  '0': ['0', 'zero', 'cero'],
  '1': ['1', 'one', 'uno', 'una', 'um', 'uma'],
  '2': ['2', 'two', 'dos', 'dois', 'duas'],
  '3': ['3', 'three', 'tres'],
  '4': ['4', 'four', 'cuatro', 'quatro'],
  '5': ['5', 'five', 'cinco'],
  '6': ['6', 'six', 'seis'],
  '7': ['7', 'seven', 'siete', 'sete'],
  '8': ['8', 'eight', 'ocho', 'oito'],
  '9': ['9', 'nine', 'nueve', 'nove'],
  '#': ['#', 'pound', 'hash', 'numeral', 'almohadilla', 'gato', 'cerquilla', 'sustenido', 'cardinal'],
  '*': ['*', 'star', 'asterisk', 'asterisco', 'estrella', 'estrela'],
};

const WORD_TO_KEY = Object.freeze(
  Object.entries(KEY_WORDS).reduce((acc, [key, words]) => {
    for (const word of words) acc[word] = key;
    return acc;
  }, {})
);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keyTokens = Object.keys(WORD_TO_KEY).map(escapeRegex).join('|');
const verbTokens = INSTRUCTION_VERBS.join('|');

// verb, then up to 6 filler words ("the number", "la tecla", "la linea, la
// tecla" — Meta's real prompt), then the key. Filler is letters only, so a
// digit is never skipped over; the lazy quantifier makes the first key win.
// The negative lookahead keeps "press 12" from matching "1" and "start" from
// matching "star".
const INSTRUCTION_RE = new RegExp(
  `\\b(?:${verbTokens})\\b(?:[\\s,]+[a-z]+){0,6}?[\\s,]+(${keyTokens})(?![a-z0-9])`,
  'i'
);

/** Lowercase + strip diacritics so "três" → "tres", "botão" → "botao". */
function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * @param {string|null|undefined} text  Transcript fragment
 * @returns {{ digit: string, matched: string } | null}
 *   digit   — DTMF key to send ("0"–"9", "#" or "*")
 *   matched — the phrase that triggered the detection, for logging
 */
function detectKeypress(text) {
  if (!text || typeof text !== 'string') return null;

  const match = normalize(text).match(INSTRUCTION_RE);
  if (!match) return null;

  const digit = WORD_TO_KEY[match[1]];
  if (!digit) return null;

  return { digit, matched: match[0].trim() };
}

// ─── Keypress mode ────────────────────────────────────────────────────────────
//
//   auto  → listen to the IVR live and press whatever key it asks for (default)
//   fixed → always press the line's configured `dtmf` digits after answering
//   none  → never press anything
//
// A line without an explicit mode inherits the global setting
// (`ivr.keypressMode`, default "auto").

const KEYPRESS_MODES = Object.freeze(['auto', 'fixed', 'none']);
const DEFAULT_KEYPRESS_MODE = 'auto';

// Only digits, "w" (0.5s pause), "#" and "*" are valid <Play digits> content —
// anything else would be TwiML injection since the value is user-configurable.
const DTMF_RE = /^[0-9w#*]+$/i;

function isKeypressMode(value) {
  return KEYPRESS_MODES.includes(value);
}

/** Returns the digits if they are safe to embed in <Play digits>, else null. */
function sanitizeDtmf(value) {
  const str = (value || '').trim();
  return str && DTMF_RE.test(str) ? str : null;
}

/**
 * Resolves the effective keypress configuration for a directory entry.
 * A "fixed" mode without valid digits degrades to "none" so a misconfigured
 * line never sends garbage tones.
 *
 * @param {string|object|undefined} entry       numbers.json entry
 * @param {string} [globalMode]                 workspace default
 * @returns {{ mode: 'auto'|'fixed'|'none', dtmf: string|null, source: 'line'|'global' }}
 */
function resolveKeypressMode(entry, globalMode = DEFAULT_KEYPRESS_MODE) {
  const lineMode = entry && typeof entry === 'object' ? entry.keypressMode : undefined;
  const dtmf = entry && typeof entry === 'object' ? sanitizeDtmf(entry.dtmf) : null;
  const fallback = isKeypressMode(globalMode) ? globalMode : DEFAULT_KEYPRESS_MODE;

  const source = isKeypressMode(lineMode) ? 'line' : 'global';
  let mode = source === 'line' ? lineMode : fallback;
  if (mode === 'fixed' && !dtmf) mode = 'none';

  return { mode, dtmf: mode === 'fixed' ? dtmf : null, source };
}

module.exports = {
  detectKeypress,
  KEYPRESS_MODES,
  DEFAULT_KEYPRESS_MODE,
  isKeypressMode,
  sanitizeDtmf,
  resolveKeypressMode,
};
