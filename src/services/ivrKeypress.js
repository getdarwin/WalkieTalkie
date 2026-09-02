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

// ─── LLM fallback ─────────────────────────────────────────────────────────────
//
// The regex catches the phrasings we have seen; an LLM catches the ones we
// haven't ("apretá el numerito ocho", garbled transcriptions, new languages).
// It only runs when the regex finds nothing, on final transcript segments, and
// it must answer strict JSON so a hallucinated digit can't leak into <Play>.

const LLM_MODEL = process.env.IVR_KEYPRESS_LLM_MODEL || 'qwen/qwen3.8-27b';
const LLM_MIN_CONFIDENCE = 0.7;
const LLM_TIMEOUT_MS = 4_000;
const LLM_MIN_WORDS = 3;

const LLM_SYSTEM_PROMPT = `You read a fragment of a live transcript from an automated phone system (IVR). \
It may be in Spanish, Portuguese or English and may contain speech-recognition errors.

Decide whether the fragment instructs the listener to press ONE phone key right now \
(e.g. "para continuar, aprieta la tecla ocho", "press 9 to confirm", "aperte a tecla 1").

Rules:
- "key" is the single key to press: "0"-"9", "#" (pound/numeral/almohadilla) or "*" (star/asterisco). Otherwise null.
- If the fragment is reading out a verification code ("su código es 1 6 9 4 2 9", "your code is 482913"), key MUST be null.
- If several keys are offered, choose the one for continuing/receiving/confirming the code.
- Never guess. If unsure, key null and low confidence.

Answer ONLY with JSON: {"key": string|null, "confidence": number between 0 and 1}`;

let defaultGroqClient = null;
function getGroqClient() {
  if (!process.env.GROQ_API_KEY) return null;
  if (!defaultGroqClient) {
    const Groq = require('groq-sdk');
    defaultGroqClient = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: LLM_TIMEOUT_MS, maxRetries: 0 });
  }
  return defaultGroqClient;
}

/**
 * Normalizes the model's JSON answer into a keypress result or null.
 * Exported for tests; tolerant of "8"/8/"eight"-style answers.
 *
 * @param {string} raw            model output (should be JSON)
 * @param {number} [minConfidence]
 * @returns {{ digit: string, confidence: number } | null}
 */
function parseLlmKeypress(raw, minConfidence = LLM_MIN_CONFIDENCE) {
  if (!raw || typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const keyRaw = parsed.key === null || parsed.key === undefined ? null : String(parsed.key).trim().toLowerCase();
  if (!keyRaw) return null;
  const digit = WORD_TO_KEY[normalize(keyRaw)];
  if (!digit) return null;

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return null;

  return { digit, confidence };
}

/**
 * Asks the LLM whether `text` instructs to press a key. Returns null when the
 * LLM is not configured, the text is too short, the call fails, or the model
 * is not confident. Never throws.
 *
 * @param {string} text
 * @param {{ client?: object }} [deps]  injectable Groq-like client for tests
 * @returns {Promise<{ digit: string, matched: string, confidence: number } | null>}
 */
async function detectKeypressWithLlm(text, { client = getGroqClient() } = {}) {
  if (!client || !text || typeof text !== 'string') return null;
  if (text.trim().split(/\s+/).length < LLM_MIN_WORDS) return null;

  try {
    const completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0,
      max_tokens: 60,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: text.trim() },
      ],
    });
    const raw = completion?.choices?.[0]?.message?.content;
    const result = parseLlmKeypress(raw);
    return result ? { ...result, matched: text.trim().slice(0, 160) } : null;
  } catch (err) {
    console.error('[ivrKeypress] LLM detection failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Two-layer detection: regex first (instant, free), LLM fallback second.
 *
 * @param {string} text
 * @param {{ useLlm?: boolean, client?: object }} [opts]
 * @returns {Promise<{ digit: string, matched: string, source: 'regex'|'llm', confidence?: number } | null>}
 */
async function detectKeypressSmart(text, { useLlm = true, client } = {}) {
  const byRegex = detectKeypress(text);
  if (byRegex) return { ...byRegex, source: 'regex' };
  if (!useLlm) return null;
  const byLlm = await detectKeypressWithLlm(text, client ? { client } : {});
  return byLlm ? { ...byLlm, source: 'llm' } : null;
}

module.exports = {
  detectKeypress,
  detectKeypressWithLlm,
  detectKeypressSmart,
  parseLlmKeypress,
  KEYPRESS_MODES,
  DEFAULT_KEYPRESS_MODE,
  isKeypressMode,
  sanitizeDtmf,
  resolveKeypressMode,
};
