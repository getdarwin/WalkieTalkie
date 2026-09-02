const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectKeypress } = require('../src/services/ivrKeypress');

const cases = [
  // English
  ['To continue, press 9.', '9'],
  ['Please press nine to receive your code', '9'],
  ['press the number 8 on your keypad', '8'],
  ['Press pound to continue', '#'],
  // Spanish
  ['Para continuar, presione el 0', '0'],
  ['Por favor oprima ocho para recibir su código', '8'],
  ['pulse la tecla uno', '1'],
  ['marque el número nueve', '9'],
  // Real Meta prompt heard in production (1 Sep 2026), live + Whisper variants
  ['Este es un mes, automático de Meta. Para continuar, aprieta la línea, la tecla ocho. Listo.', '8'],
  ['este es un mensaje automático de meta para continuar aprieta la línea la tecla 8 listo', '8'],
  ['Para continuar, apretá la tecla número cero', '0'],
  ['Oprimí el uno para seguir', '1'],
  // Portuguese
  ['Para continuar, pressione 1', '1'],
  ['Aperte a tecla oito', '8'],
  ['digite três para continuar', '3'],
  ['Pressione o número nove', '9'],
];

for (const [text, expected] of cases) {
  test(`detects "${expected}" in: ${text}`, () => {
    const result = detectKeypress(text);
    assert.ok(result, 'expected a match');
    assert.equal(result.digit, expected);
  });
}

const negatives = [
  'Your verification code is 1 6 9 4 2 9',
  'Su código de verificación es 4 5 6 7 8 9',
  'Seu código é 123456',
  'Thank you for calling, goodbye',
  'Press start on the machine',
  '',
  null,
];

for (const text of negatives) {
  test(`no keypress in: ${JSON.stringify(text)}`, () => {
    assert.equal(detectKeypress(text), null);
  });
}

test('first instruction wins when several appear', () => {
  assert.equal(detectKeypress('Presione 5 para continuar o presione 1 para repetir').digit, '5');
});

test('returns the matched phrase for logging', () => {
  const r = detectKeypress('Hello. To verify your number, press 9 now.');
  assert.match(r.matched, /press 9/i);
});
