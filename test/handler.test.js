import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../lib/handler.js';
import { createDedup } from '../lib/dedup.js';
import { parseEvolutionEvent } from '../lib/evolution.js';

const SEC = 'segredo-teste';
const ENV = { EVOLUTION_WEBHOOK_SECRET: SEC, ALLOWED_CLIENTS: 'acme,beta' };
const up = (id, key = {}, data = {}) => ({ event: 'messages.upsert', apikey: 'CHAVE-INSTANCIA', data: { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id, ...key }, message: { conversation: 'orçamento privado' }, messageType: 'conversation', messageTimestamp: 1760000000, ...data } });

function call(handler, { method = 'POST', secret = SEC, client = 'acme', body } = {}) {
  return new Promise((resolve) => {
    const res = { status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method, headers: secret === null ? {} : { 'x-webhook-secret': secret }, query: { client }, body }, res);
  });
}
const mk = (env = ENV, extra = {}) => { const fwd = []; const logs = []; const orig = console.log; return { fwd, logs, h: createHandler({ env, forward: async (cfg, m, o) => { fwd.push({ m, o }); return 200; }, waitUntil: (p) => p, ...extra }) }; };

test('método e autenticação: 405, 503 sem segredo, 401 errado/ausente (corpo apikey não autentica)', async () => {
  const { h } = mk();
  assert.equal((await call(h, { method: 'GET' })).code, 405);
  assert.equal((await call(h, { secret: null, body: up('A') })).code, 401);
  assert.equal((await call(h, { secret: 'errado', body: up('A') })).code, 401);
  assert.equal((await call(createHandler({ env: {} }), { body: up('A') })).code, 503);
});
test('cliente fora da lista/mal formado: 404; evento inválido: 422', async () => {
  const { h } = mk();
  assert.equal((await call(h, { client: 'outro', body: up('A') })).code, 404);
  assert.equal((await call(h, { client: '../x', body: up('A') })).code, 404);
  assert.equal((await call(h, { body: { event: 'messages.upsert', data: {} } })).code, 422);
});
test('QR, conexão, fromMe, broadcast e outros eventos: 200 e NADA encaminhado', async () => {
  const { h, fwd } = mk({ ...ENV, FORWARD_URL: 'https://destino.exemplo.com/x' });
  const r = [
    await call(h, { body: { event: 'qrcode.updated', data: { qrcode: { base64: 'x' } } } }),
    await call(h, { body: { event: 'connection.update', data: { state: 'open' } } }),
    await call(h, { body: up('B', { fromMe: true }) }),
    await call(h, { body: up('C', { remoteJid: 'status@broadcast' }) }),
    await call(h, { body: { event: 'chats.upsert', data: [] } }),
  ];
  assert.deepEqual(r.map((x) => x.code), [200, 200, 200, 200, 200]);
  assert.equal(fwd.length, 0);
});
test('mensagem real: 202, duplicada 200, encaminhada uma vez; sem destino configurado: 202 accepted_no_destination', async () => {
  const { h, fwd } = mk({ ...ENV, FORWARD_URL: 'https://destino.exemplo.com/x', FORWARD_TOKEN: 't' });
  assert.deepEqual((await call(h, { body: up('D') })).body, { status: 'accepted' });
  assert.deepEqual((await call(h, { body: up('D') })).body, { status: 'duplicate' });
  assert.equal(fwd.length, 1); assert.equal(fwd[0].m.text, 'orçamento privado'); assert.equal(fwd[0].o.client, 'acme');
  const { h: h2, fwd: f2 } = mk();
  assert.deepEqual((await call(h2, { body: up('E') })).body, { status: 'accepted_no_destination' });
  assert.equal(f2.length, 0);
});
test('FORWARD_URL não-HTTPS: 500 e nada enviado', async () => {
  const { h, fwd } = mk({ ...ENV, FORWARD_URL: 'http://x.exemplo.com' });
  assert.equal((await call(h, { body: up('F') })).code, 500);
  assert.equal(fwd.length, 0);
});
test('logs não vazam conteúdo, remetente, segredo nem chave', async () => {
  const lines = []; const orig = console.log; console.log = (l) => lines.push(l);
  try {
    const { h } = mk({ ...ENV, FORWARD_URL: 'https://destino.exemplo.com/x', FORWARD_TOKEN: 'TOKEN-X' });
    await call(h, { body: up('G') }); await call(h, { secret: 'errado', body: up('H') });
  } finally { console.log = orig; }
  const all = lines.join('\n');
  for (const bad of ['orçamento privado', '5511999999999', 'CHAVE-INSTANCIA', SEC, 'TOKEN-X']) assert.ok(!all.includes(bad), `vazou ${bad}`);
});
test('dedup: expira por TTL e limita o tamanho', () => {
  let t = 0; const d = createDedup({ ttlMs: 100, max: 3, now: () => t });
  assert.equal(d.check('a'), false); assert.equal(d.check('a'), true);
  t = 200; assert.equal(d.check('a'), false);
  for (const k of ['b', 'c', 'd', 'e']) d.check(k);
  assert.ok(d.size() <= 3);
});
test('parse: grupo usa participante; texto estendido', () => {
  const g = parseEvolutionEvent(up('G1', { remoteJid: '1203@g.us', participant: '5511888888888@s.whatsapp.net' }, { message: { extendedTextMessage: { text: 'oi' } } }));
  assert.equal(g.senderId, '5511888888888@s.whatsapp.net'); assert.equal(g.text, 'oi');
});
