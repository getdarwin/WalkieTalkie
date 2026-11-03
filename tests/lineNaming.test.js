const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildLineName, highestSequence, normalizeE164, cleanText, directoryNames } = require('../src/services/lineNaming');

test('first line of a client has no number', () => {
  assert.equal(buildLineName({ client: 'Chirey Coacalco', owner: 'Andrea' }, ['NP Digital']), 'Chirey Coacalco - Andrea');
});

test('second line gets " 2" before the owner', () => {
  assert.equal(
    buildLineName({ client: 'Chirey Coacalco', owner: 'Andrea' }, ['Chirey Coacalco - Andrea']),
    'Chirey Coacalco 2 - Andrea'
  );
});

test('picks the highest existing number + 1, regardless of owner', () => {
  const existing = ['Acme - Andrea', 'Acme 2 - Santi', 'Acme 5 - Andrea', 'Acme Corp - Juan'];
  assert.equal(buildLineName({ client: 'Acme', owner: 'Julio' }, existing), 'Acme 6 - Julio');
});

test('legacy names already numbered from 1 are respected', () => {
  assert.equal(buildLineName({ client: 'Grupo Randazzo' }, ['Grupo Randazzo 1', 'Grupo Randazzo 2']), 'Grupo Randazzo 3');
});

test('matching is case-insensitive and whitespace-tolerant', () => {
  assert.equal(buildLineName({ client: '  chirey   coacalco ' }, ['Chirey Coacalco']), 'chirey coacalco 2');
});

test('a longer client name that starts with the same words is not counted', () => {
  assert.equal(highestSequence('Go virtual', ['Go virtual2', 'Go virtuales 1']), 0);
});

test('regex characters in the client name are escaped', () => {
  assert.equal(buildLineName({ client: 'A+B (MX)' }, ['A+B (MX) - Ana', 'AAB (MX)']), 'A+B (MX) 2');
});

test('owner is dropped when missing', () => {
  assert.equal(buildLineName({ client: 'NP Digital', owner: '   ' }, []), 'NP Digital');
});

test('no client → empty name (caller keeps the raw number)', () => {
  assert.equal(buildLineName({ client: '', owner: 'Andrea' }, []), '');
  assert.equal(buildLineName(undefined, []), '');
});

test('cleanText strips control characters and caps the length', () => {
  assert.equal(cleanText('Acme\n\tMX'), 'Acme MX');
  assert.equal(cleanText('x'.repeat(200)).length, 80);
});

test('normalizeE164 accepts formatted numbers and rejects junk', () => {
  assert.equal(normalizeE164('+54 11 4899-9365'), '+541148999365');
  assert.equal(normalizeE164('541148999365'), '+541148999365');
  assert.equal(normalizeE164('123'), '');
  assert.equal(normalizeE164(undefined), '');
});

test('directoryNames reads string and object entries', () => {
  assert.deepEqual(directoryNames({ '+1': 'A', '+2': { name: 'B', channel: 'C1' }, '+3': '', '+4': { channel: 'C2' } }), ['A', 'B']);
});
