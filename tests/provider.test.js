const test = require('node:test');
const assert = require('node:assert');
const { normalizeProvider, entryProvider, isZadarmaEntry, buildEntry } = require('../src/services/provider');

test('normalizeProvider: solo twilio|zadarma, el resto cae a twilio', () => {
  assert.strictEqual(normalizeProvider('zadarma'), 'zadarma');
  assert.strictEqual(normalizeProvider('  ZADARMA '), 'zadarma');
  assert.strictEqual(normalizeProvider('twilio'), 'twilio');
  assert.strictEqual(normalizeProvider(''), 'twilio');
  assert.strictEqual(normalizeProvider(undefined), 'twilio');
  assert.strictEqual(normalizeProvider('vonage'), 'twilio');
});

test('entryProvider: entradas legacy (string, objeto sin provider) son twilio', () => {
  assert.strictEqual(entryProvider('Mi línea'), 'twilio');
  assert.strictEqual(entryProvider(''), 'twilio');
  assert.strictEqual(entryProvider(undefined), 'twilio');
  assert.strictEqual(entryProvider({ name: 'x' }), 'twilio');
  assert.strictEqual(entryProvider({ name: 'x', provider: 'zadarma' }), 'zadarma');
});

test('isZadarmaEntry', () => {
  assert.strictEqual(isZadarmaEntry({ provider: 'zadarma' }), true);
  assert.strictEqual(isZadarmaEntry('x'), false);
});

test('buildEntry: provider twilio no se persiste (retrocompatible); zadarma sí', () => {
  assert.deepStrictEqual(buildEntry({ name: 'A', provider: 'twilio' }), 'A');
  assert.deepStrictEqual(buildEntry({ name: 'A', provider: 'zadarma' }), { name: 'A', provider: 'zadarma' });
  assert.deepStrictEqual(buildEntry({}), '');
  assert.deepStrictEqual(
    buildEntry({ name: 'A', channel: 'C0123456', provider: 'zadarma', routing: 'vapi', keypressMode: 'auto', dtmf: 'ww1', language: 'es' }),
    { name: 'A', channel: 'C0123456', dtmf: 'ww1', language: 'es', keypressMode: 'auto', routing: 'vapi', provider: 'zadarma' },
  );
});
