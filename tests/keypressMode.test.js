const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveKeypressMode, sanitizeDtmf, isKeypressMode } = require('../src/services/ivrKeypress');

test('string entry inherits the global default (auto)', () => {
  assert.deepEqual(resolveKeypressMode('Marketing Line'), { mode: 'auto', dtmf: null, source: 'global' });
});

test('undefined entry inherits the global default', () => {
  assert.deepEqual(resolveKeypressMode(undefined), { mode: 'auto', dtmf: null, source: 'global' });
});

test('legacy entry with dtmf but no mode still inherits auto (fixed digit was the bug)', () => {
  assert.deepEqual(resolveKeypressMode({ name: 'AR 1', dtmf: 'wwww1' }), { mode: 'auto', dtmf: null, source: 'global' });
});

test('global none applies when the line has no override', () => {
  assert.equal(resolveKeypressMode({ name: 'x' }, 'none').mode, 'none');
});

test('line override beats the global setting', () => {
  assert.equal(resolveKeypressMode({ keypressMode: 'auto' }, 'none').mode, 'auto');
  assert.equal(resolveKeypressMode({ keypressMode: 'none' }, 'auto').mode, 'none');
});

test('fixed mode returns its sanitized digits', () => {
  assert.deepEqual(resolveKeypressMode({ keypressMode: 'fixed', dtmf: 'ww1' }), { mode: 'fixed', dtmf: 'ww1', source: 'line' });
});

test('fixed mode without valid digits degrades to none', () => {
  assert.equal(resolveKeypressMode({ keypressMode: 'fixed' }).mode, 'none');
  assert.equal(resolveKeypressMode({ keypressMode: 'fixed', dtmf: '<Say>x</Say>' }).mode, 'none');
});

test('unknown global mode falls back to auto', () => {
  assert.equal(resolveKeypressMode({}, 'banana').mode, 'auto');
});

test('sanitizeDtmf accepts digits, w, # and *, rejects anything else', () => {
  assert.equal(sanitizeDtmf(' ww9# '), 'ww9#');
  assert.equal(sanitizeDtmf('*1'), '*1');
  assert.equal(sanitizeDtmf('1 2'), null);
  assert.equal(sanitizeDtmf(''), null);
  assert.equal(sanitizeDtmf(null), null);
});

test('isKeypressMode', () => {
  assert.equal(isKeypressMode('auto'), true);
  assert.equal(isKeypressMode('fixed'), true);
  assert.equal(isKeypressMode('none'), true);
  assert.equal(isKeypressMode(''), false);
  assert.equal(isKeypressMode('AUTO'), false);
});
