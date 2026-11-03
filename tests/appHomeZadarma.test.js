const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const memory = new Map();
function stubModule(relPath, exports) {
  const file = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stubModule('src/services/store.js', {
  getJSON: async (key) => (memory.has(key) ? structuredClone(memory.get(key)) : null),
  setJSON: async (key, value) => { memory.set(key, structuredClone(value)); },
  setJSONIfAbsent: async () => true,
  del: async () => {},
  listPush: async () => {},
  listRange: async () => [],
  usingRedis: false,
});

const { buildAppHomeView, buildNumberModal, buildZadarmaCredentialsModal } = require('../src/bolt/views');

const SECRET = 'SUPER-SECRET-VALUE-123';

beforeEach(() => {
  memory.clear();
  memory.set('numbers', {
    '+12025550101': 'Línea Twilio',
    '+528718430130': { name: 'Zadarma Torreón', provider: 'zadarma', keypressMode: 'auto' },
  });
  memory.set('settings', { zadarma: { apiKey: 'KEY-ABC', apiSecret: SECRET }, slack: { defaultChannel: 'C0DEFAULT1' } });
});

const flat = (view) => JSON.stringify(view);

test('App Home: línea Zadarma muestra badge ZADARMA y "Voz vía SIP"; la de Twilio no', async () => {
  const view = await buildAppHomeView();
  const sections = view.blocks.filter((b) => b.type === 'section' && b.text && b.text.text.includes('`+'));
  const zad = sections.find((b) => b.text.text.includes('+528718430130'));
  const tw = sections.find((b) => b.text.text.includes('+12025550101'));
  assert.match(zad.text.text, /ZADARMA/);
  assert.match(zad.text.text, /Voz vía SIP/);
  assert.doesNotMatch(zad.text.text, /not scanned/);
  assert.doesNotMatch(tw.text.text, /ZADARMA/);
});

test('App Home: sección de credenciales Zadarma configurada, sin exponer key ni secret', async () => {
  const text = flat(await buildAppHomeView());
  assert.match(text, /Zadarma Credentials/);
  assert.match(text, /action_edit_zadarma_credentials/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('KEY-ABC'), false);
});

test('App Home: sin credenciales Zadarma lo indica', async () => {
  memory.set('settings', { slack: { defaultChannel: 'C0DEFAULT1' } });
  assert.match(flat(await buildAppHomeView()), /Zadarma Credentials[\s\S]*Not configured/);
});

test('modal de credenciales: nunca muestra valores guardados', async () => {
  const text = flat(await buildZadarmaCredentialsModal());
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('KEY-ABC'), false);
  assert.match(text, /modal_zadarma_credentials/);
  assert.match(text, /already configured/);
});

test('modal de línea: selector de proveedor con el valor actual', () => {
  const zad = buildNumberModal('+528718430130', { name: 'Z', provider: 'zadarma' }, 'auto');
  const sel = zad.blocks.find((b) => b.block_id === 'block_provider').element;
  assert.equal(sel.initial_option.value, 'zadarma');
  const tw = buildNumberModal('+12025550101', 'Línea Twilio', 'auto');
  assert.equal(tw.blocks.find((b) => b.block_id === 'block_provider').element.initial_option.value, 'twilio');
});
