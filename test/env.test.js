import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv, presence, configStatus } from '../lib/env.js';

test('env: valida requeridas', () => {
  assert.throws(() => validateEnv({}), /EVOLUTION_WEBHOOK_SECRET.*required/);
  assert.throws(() => validateEnv({ EVOLUTION_WEBHOOK_SECRET: '' }), /ALLOWED_CLIENTS.*required/);
  assert.throws(() => validateEnv({ EVOLUTION_WEBHOOK_SECRET: 'x', ALLOWED_CLIENTS: '' }), /ALLOWED_CLIENTS.*required/);
});

test('env: rejeita formato inválido', () => {
  const base = { EVOLUTION_WEBHOOK_SECRET: 'segredao', ALLOWED_CLIENTS: 'client' };
  assert.throws(() => validateEnv({ ...base, PORT: '999999' }), /PORT.*invalid/);
  assert.throws(() => validateEnv({ ...base, REPLY_PER_MINUTE: '-1' }), /REPLY_PER_MINUTE.*invalid/);
  assert.throws(() => validateEnv({ ...base, FORWARD_URL: 'not-a-url' }), /FORWARD_URL.*invalid/);
  assert.throws(() => validateEnv({ ...base, FORWARD_EXTRA_HEADERS: '{broken' }), /FORWARD_EXTRA_HEADERS.*invalid/);
});

test('env: rejeita tamanho mínimo de segredo', () => {
  assert.throws(() => validateEnv({ EVOLUTION_WEBHOOK_SECRET: 'short', ALLOWED_CLIENTS: 'client1' }), /EVOLUTION_WEBHOOK_SECRET.*min 10/);
});

test('env: FORWARD_TOKEN obrigatório se FORWARD_URL presente', () => {
  const base = { EVOLUTION_WEBHOOK_SECRET: 'segredao1234', ALLOWED_CLIENTS: 'c', FORWARD_URL: 'https://example.com' };
  assert.throws(() => validateEnv(base), /FORWARD_TOKEN.*required when FORWARD_URL/);
  validateEnv({ ...base, FORWARD_TOKEN: 'token1234' }); // não lança
});

test('env: EVOLUTION_API_* obrigatório se SEND_SECRET presente', () => {
  const base = { EVOLUTION_WEBHOOK_SECRET: 'segredao1234', ALLOWED_CLIENTS: 'c', SEND_SECRET: 'envio1234567' };
  assert.throws(() => validateEnv(base), /EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE.*required when SEND_SECRET/);
});

test('env: presença (sem valores)', () => {
  const p = presence({ EVOLUTION_WEBHOOK_SECRET: 'x', ALLOWED_CLIENTS: 'c' });
  assert.ok(p.EVOLUTION_WEBHOOK_SECRET);
  assert.ok(p.ALLOWED_CLIENTS);
  assert.strictEqual(p.FORWARD_URL, false);
});

test('env: configStatus (sem valores)', () => {
  const s = configStatus({});
  assert.strictEqual(s.EVOLUTION_WEBHOOK_SECRET.required, true);
  assert.strictEqual(s.PORT.required, false);
  assert.ok(s.EVOLUTION_WEBHOOK_SECRET.note);
});

test('env: sucesso com mínimo', () => {
  const v = validateEnv({ EVOLUTION_WEBHOOK_SECRET: 'segredao-ok', ALLOWED_CLIENTS: 'client1,client2' });
  assert.strictEqual(v.EVOLUTION_WEBHOOK_SECRET, 'segredao-ok');
  assert.strictEqual(v.PORT, '3000'); // default
});
