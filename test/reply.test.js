import test from 'node:test';
import assert from 'node:assert/strict';
import { variants, numberOf, registrable } from '../lib/numbers.js';
import { createSendHandler } from '../lib/send.js';
import { createLimiter } from '../lib/api.js';
import { createEvo } from '../lib/evo.js';
import { world, fakeEvo, ADMIN, ENV } from './helpers.js';

test('numbers: variantes só do 9 brasileiro; grupo e @lid nunca viram número; cadastro exige DDI', () => {
  assert.deepEqual([...variants(ADMIN)].sort(), ['558592494552', ADMIN].sort());
  assert.equal(numberOf(`${ADMIN}@s.whatsapp.net`), ADMIN);
  assert.equal(numberOf(`${ADMIN}@g.us`), '');
  assert.equal(numberOf('123456789012@lid'), '');
  assert.equal(registrable('+55 85 99249-4552'), ADMIN);
  assert.equal(registrable('85992494552'), null, 'sem DDI é ambíguo');
  assert.equal(registrable('123'), null);
});

const call = (h, { method = 'POST', secret = 'segredo-rotina', body } = {}) => new Promise((resolve) => {
  const res = { status(c) { this.c = c; return this; }, json(o) { resolve({ code: this.c, body: o }); } };
  h({ method, headers: secret ? { 'x-send-secret': secret } : {}, body }, res);
});

test('legado /api/send: exige interruptor, segredo, acesso do destinatário e respeita limites', async () => {
  const evo = fakeEvo(); const w = world({ evo });
  try {
    const mk = (extra = {}) => createSendHandler({ env: { ...ENV, ...extra }, access: w.access, evo, limiter: createLimiter({ perMinute: 2, perDay: 3, now: () => w.clock.t }) });
    assert.equal((await call(mk({ REPLY_ENABLED: 'false' }), { body: { to: ADMIN, text: 'oi' } })).code, 503);
    const h = mk({ SEND_SECRET: 'segredo-rotina' });
    assert.equal((await call(h, { secret: null, body: { to: ADMIN, text: 'oi' } })).code, 401);
    assert.equal((await call(h, { body: { to: '5585999999999', text: 'oi' } })).code, 403, 'sem acesso');
    assert.equal((await call(h, { body: { to: '1203@g.us', text: 'oi' } })).code, 422);
    assert.equal((await call(h, { body: { to: ADMIN, text: 'x'.repeat(1001) } })).code, 422);
    assert.equal((await call(h, { body: { to: ADMIN, text: 'um' } })).code, 200);
    assert.equal((await call(h, { body: { to: ADMIN, text: 'dois' } })).code, 200);
    assert.equal((await call(h, { body: { to: ADMIN, text: 'tres' } })).body.error, 'minute_limit');
    assert.equal(evo.calls.filter((c) => c.name === 'sendText').length, 2);
  } finally { w.close(); }
});

test('evo: apikey no header; GET sem corpo; erro de rede vira uncertain, HTTP 4xx vira rejected', async () => {
  const seen = [];
  const env = { EVOLUTION_API_URL: 'https://evo.exemplo.com/', EVOLUTION_API_KEY: 'CHAVE', EVOLUTION_INSTANCE: 'ins tância' };
  const ok = createEvo({ env, fetchImpl: async (u, i) => { seen.push({ u, i }); return { status: 201, json: async () => ({ ok: 1 }) }; } });
  assert.equal((await ok.sendPoll({ number: '1', name: 'q', values: ['a', 'b'], selectableCount: 1 })).kind, 'ok');
  assert.equal(seen[0].u, 'https://evo.exemplo.com/message/sendPoll/ins%20t%C3%A2ncia');
  assert.equal(seen[0].i.headers.apikey, 'CHAVE');
  await ok.findGroupInfos('1203@g.us');
  assert.match(seen[1].u, /\/group\/findGroupInfos\/ins%20t%C3%A2ncia\?groupJid=1203%40g\.us$/);
  assert.equal(seen[1].i.body, undefined);
  assert.equal((await createEvo({ env, fetchImpl: async () => { throw new Error('timeout'); } }).sendText({ number: '1', text: 't' })).kind, 'uncertain');
  assert.equal((await createEvo({ env, fetchImpl: async () => ({ status: 400, json: async () => ({}) }) }).sendText({ number: '1', text: 't' })).kind, 'rejected');
  await assert.rejects(createEvo({ env: {}, fetchImpl: async () => ({}) }).sendText({}), /evolution não configurada/);
});
