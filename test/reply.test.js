import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, variants, numberOf } from '../lib/allow.js';
import { createSendHandler, createLimiter } from '../lib/send.js';
import { createDispatcher } from '../lib/dispatch.js';

const OK = '5585992494552';
const ENV = { ALLOWED_SENDERS: OK, REPLY_ENABLED: 'true', SEND_SECRET: 'segredo-envio', EVOLUTION_API_URL: 'https://evo.exemplo.com', EVOLUTION_API_KEY: 'CHAVE-EVO', EVOLUTION_INSTANCE: 'inst' };

test('allow: casa com e sem o 9; ignora grupos, @lid e outros números', () => {
  assert.ok(isAllowed(ENV, `${OK}@s.whatsapp.net`));
  assert.ok(isAllowed(ENV, '558592494552@s.whatsapp.net'), 'sem o 9');
  assert.ok(isAllowed(ENV, OK));
  assert.ok(!isAllowed(ENV, '5585999999999@s.whatsapp.net'));
  assert.ok(!isAllowed(ENV, `${OK}@g.us`));
  assert.ok(!isAllowed(ENV, '123456789012@lid'));
  assert.ok(isAllowed(ENV, '123456789012@lid', `${OK}@s.whatsapp.net`), 'alternativo permitido');
  assert.ok(!isAllowed({}, OK), 'lista vazia nega tudo');
  assert.deepEqual([...variants(OK)].sort(), ['558592494552', OK].sort());
  assert.equal(numberOf('x@lid'), '');
});

function call(h, { method = 'POST', secret = 'segredo-envio', body } = {}) {
  return new Promise((resolve) => { const res = { status(c) { this.c = c; return this; }, json(o) { resolve({ code: this.c, body: o }); } }; h({ method, headers: secret ? { 'x-send-secret': secret } : {}, body }, res); });
}

test('send: recusa sem interruptor, sem/segredo errado, número fora da lista, grupo/JID, texto inválido', async () => {
  const sent = []; const send = async (a) => { sent.push(a); return 201; };
  const h = createSendHandler({ env: ENV, send });
  assert.equal((await call(createSendHandler({ env: { ...ENV, REPLY_ENABLED: 'false' }, send }), { body: { to: OK, text: 'oi' } })).code, 503);
  assert.equal((await call(h, { secret: null, body: { to: OK, text: 'oi' } })).code, 401);
  assert.equal((await call(h, { secret: 'x', body: { to: OK, text: 'oi' } })).code, 401);
  assert.equal((await call(h, { body: { to: '5585999999999', text: 'oi' } })).code, 403);
  assert.equal((await call(h, { body: { to: '1203@g.us', text: 'oi' } })).code, 422);
  assert.equal((await call(h, { body: { to: `${OK}@s.whatsapp.net`, text: 'oi' } })).code, 422);
  assert.equal((await call(h, { body: { to: OK, text: '   ' } })).code, 422);
  assert.equal((await call(h, { body: { to: OK, text: 'x'.repeat(1001) } })).code, 422);
  assert.equal((await call(h, { method: 'GET' })).code, 405);
  assert.equal(sent.length, 0);
});
test('send: envia ao número permitido; limites por minuto e por dia; falha do Evolution vira 502', async () => {
  const sent = []; let t = 0;
  const h = createSendHandler({ env: ENV, send: async (a) => { sent.push(a); return 201; }, limiter: createLimiter({ perMinute: 2, perDay: 3, now: () => t }) });
  assert.deepEqual((await call(h, { body: { to: OK, text: 'um' } })).body, { status: 'sent' });
  assert.equal((await call(h, { body: { to: OK, text: 'dois' } })).code, 200);
  assert.equal((await call(h, { body: { to: OK, text: 'tres' } })).code, 429);
  t = 61_000; assert.equal((await call(h, { body: { to: OK, text: 'quatro' } })).code, 200);
  assert.equal((await call(h, { body: { to: OK, text: 'cinco' } })).body.error, 'daily_limit');
  assert.deepEqual(sent.map((s) => s.number), [OK, OK, OK]);
  assert.equal((await call(createSendHandler({ env: ENV, send: async () => 500 }), { body: { to: OK, text: 'x' } })).code, 502);
  assert.equal((await call(createSendHandler({ env: ENV, send: async () => { throw new Error('rede'); } }), { body: { to: OK, text: 'x' } })).code, 502);
});
test('send: logs não vazam texto, número nem segredos', async () => {
  const lines = []; const orig = console.log; console.log = (l) => lines.push(l);
  try { const h = createSendHandler({ env: ENV, send: async () => 201 }); await call(h, { body: { to: OK, text: 'texto privado' } }); await call(h, { secret: 'errado', body: { to: OK, text: 'texto privado' } }); }
  finally { console.log = orig; }
  const all = lines.join('\n');
  for (const bad of ['texto privado', OK, 'segredo-envio', 'CHAVE-EVO']) assert.ok(!all.includes(bad), `vazou ${bad}`);
});
test('sendText: usa apikey no header e o corpo {number,text} no endpoint da instância', async () => {
  const { sendText } = await import('../lib/send.js'); const calls = [];
  await sendText({ env: ENV, number: OK, text: 'oi', fetchImpl: async (u, i) => { calls.push({ u, i }); return { status: 201 }; } });
  assert.equal(calls[0].u, 'https://evo.exemplo.com/message/sendText/inst');
  assert.equal(calls[0].i.headers.apikey, 'CHAVE-EVO');
  assert.deepEqual(JSON.parse(calls[0].i.body), { number: OK, text: 'oi' });
});

test('dispatcher: só permitidos e recentes chegam à rotina; terceiros e antigas são concluídas sem encaminhar', async () => {
  const fwd = []; const logs = []; let t = 1_000_000;
  const d = createDispatcher({ env: { ...ENV, PUBLIC_BASE_URL: 'https://r.exemplo.com/' }, cfg: { url: 'https://x' }, now: () => t, log: (e, f) => logs.push([e, f.code]), forward: async (c, m, o) => { fwd.push({ m, o }); return 200; } });
  const ev = (sender, at, extra = {}) => ({ client: 'worki', conv: sender, sender, payload: { type: 'conversation', text: 'oi', receivedAt: at, ...extra } });
  await d(ev(`${OK}@s.whatsapp.net`, t));
  await d(ev('5585999999999@s.whatsapp.net', t));
  await d(ev(`${OK}@s.whatsapp.net`, t - 700_000));
  await d(ev('999@lid', t, { senderAlt: `${OK}@s.whatsapp.net` }));
  assert.equal(fwd.length, 2);
  assert.equal(fwd[0].m.to, OK); assert.equal(fwd[0].o.replyUrl, 'https://r.exemplo.com/api/send');
  assert.deepEqual(logs.map((l) => l[1]), ['not_allowed', 'stale']);
  const bad = createDispatcher({ env: ENV, cfg: {}, now: () => t, forward: async () => 500 });
  await assert.rejects(bad(ev(`${OK}@s.whatsapp.net`, t)), /destino recusou/);
});
