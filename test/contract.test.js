// Contrato receptor × prompt da rotina × rotina simulada. A "rotina" aqui só faz o que o prompt manda, lendo o texto de
// disparo como o modelo leria; prova que o formato do disparo, as rotas citadas e os headers batem com o código.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler } from '../lib/handler.js';
import { createStore, drain } from '../lib/store.js';
import { createDispatcher } from '../lib/dispatch.js';
import { world, fakeEvo, ADMIN, ENV } from './helpers.js';

const docs = ['docs/routine-prompt.md', 'ROUTINE.md'].map((f) => readFileSync(f, 'utf8')).join('\n');
const GROUP = '120363000000000001@g.us';

test('contrato: toda rota citada no prompt e no guia existe na API (ou é a legada/de entrada)', () => {
  const w = world();
  try {
    const cited = [...new Set(docs.match(/\/api\/[a-z0-9\/_-]+/g))].map((r) => r.replace(/\/$/, ''));
    const known = new Set([...w.api.routes, '/api/send', '/api/evolution', '/api/ops', '/api/admin', '/api/task']);
    const unknown = cited.filter((r) => !known.has(r) && ![...known].some((k) => k.startsWith(r + '/')));
    assert.deepEqual(unknown, []);
    // e as rotas de prompt realmente usadas pelo procedimento
    for (const r of ['/api/ops/me', '/api/ops/can', '/api/ops/record', '/api/ops/page/publish', '/api/ops/instagram/prepare', '/api/ops/instagram/publish', '/api/task/reply', '/api/ops/handoff', '/api/ops/history', '/api/admin/access']) assert.ok(w.api.routes.includes(r), r);
  } finally { w.close(); }
});

test('contrato: o texto de disparo traz tudo o que o prompt manda usar', async () => {
  const w = world();
  try {
    const { buildFireText } = await import('../lib/prompt.js');
    const { task, token } = w.tasks.issue({ eventKey: 'worki:1', sender: ADMIN, conv: `${ADMIN}@s.whatsapp.net`, isGroup: false, client: null, msgId: 'M1', request: 'oi' });
    const text = buildFireText({ task, token, text: 'oi', type: 'conversation', access: w.access, baseUrl: 'https://r.exemplo.com' });
    for (const campo of ['token da tarefa:', 'remetente verificado:', 'permissões efetivas:', 'API:', '--- mensagem ---', '--- fim ---', 'X-Send-Secret', 'Authorization: Bearer']) assert.ok(text.includes(campo), campo);
    for (const termo of ['routine-fire-payload', 'token da tarefa', 'X-Send-Secret', 'Authorization: Bearer', 'remetente verificado', 'permissões efetivas', '--- mensagem ---']) assert.ok(docs.includes(termo), `prompt não menciona: ${termo}`);
  } finally { w.close(); }
});

test('rotina simulada ponta a ponta: webhook → fila → disparo → rotina lê o texto → cria grupo só com o contato → responde', async () => {
  const OWNER = '5585911110000';
  const evo = fakeEvo({
    createGroup: () => ({ kind: 'ok', http: 201, data: { id: GROUP, subject: 'Worki digital operação' } }),
    findGroupInfos: () => ({ kind: 'ok', http: 200, data: { id: GROUP, subject: 'Worki digital operação', owner: `${OWNER}@s.whatsapp.net`, participants: [{ id: `${OWNER}@s.whatsapp.net`, admin: 'superadmin' }, { id: `${ADMIN}@s.whatsapp.net` }] } }),
  });
  const w = world({ evo, env: { PUBLIC_BASE_URL: 'https://r.exemplo.com', EVOLUTION_WEBHOOK_SECRET: 'sw', ALLOWED_CLIENTS: 'worki' } });
  const store = createStore(w.dir, { backoffMs: 0 });
  let routine;
  try {
    const hook = createHandler({ env: { EVOLUTION_WEBHOOK_SECRET: 'sw', ALLOWED_CLIENTS: 'worki' }, store, waitUntil: (p) => p });
    const post = (body) => new Promise((resolve) => hook({ method: 'POST', headers: { 'x-webhook-secret': 'sw' }, query: { client: 'worki' }, body }, { status(c) { this.c = c; return this; }, json(o) { resolve({ code: this.c, body: o }); } }));
    const ev = (id, jid) => ({ event: 'messages.upsert', data: { key: { remoteJid: jid, fromMe: false, id }, message: { conversation: 'Crie um grupo no WhatsApp com o nome Worki digital operação e coloca este contato' }, messageType: 'conversation' } });
    assert.equal((await post(ev('A1', `${ADMIN}@s.whatsapp.net`))).code, 202);
    assert.equal((await post(ev('A2', '5585900000007@s.whatsapp.net'))).code, 202, 'desconhecido também entra na fila, mas não vira tarefa');

    // "rotina": só age sobre o que está no texto, usando as rotas do prompt
    const fireImpl = async (_cfg, text) => {
      const token = /token da tarefa: (\S+)/.exec(text)[1];
      assert.match(text, /remetente verificado: 5585988880001/);
      routine = (async () => {
        const call = (p, b) => w.call(p, token, b);
        assert.equal((await call('/api/ops/me', {})).code, 200);
        assert.equal((await call('/api/ops/can', { op: 'create_whatsapp_group', client: 'worki' })).body.allowed, true);
        await call('/api/ops/record', { op: 'create_whatsapp_group', client: 'worki', status: 'started', ref: 'grupo-op' }).catch(() => {});
        const g = await call('/api/ops/whatsapp/create-group', { client: 'worki', subject: 'Worki digital operação', includeRequester: true });
        assert.equal(g.body.status, 'verified'); assert.deepEqual(g.body.result.unexpected, []);
        await call('/api/task/reply', { text: `Grupo criado: ${g.body.result.subject}` });
      })();
      return 200;
    };
    const d = createDispatcher({ env: { PUBLIC_BASE_URL: 'https://r.exemplo.com', MAX_AGE_SECONDS: '600' }, cfg: { url: 'https://x' }, access: w.access, tasks: w.tasks, fireImpl, log: () => {} });
    await drain(store.queue, d);
    await routine;

    const t = [...w.tasks.tasks.values()];
    assert.equal(t.length, 1, 'só o administrador virou tarefa');
    assert.equal(t[0].state, 'replied');
    const calls = evo.calls.map((c) => c.name);
    assert.deepEqual(calls, ['fetchAllGroups', 'createGroup', 'findGroupInfos', 'sendText'], 'pré-verificação antes de criar');
    assert.deepEqual(evo.calls[1].arg.participants, [ADMIN], 'somente o contato do operador (a conta do agente entra como criadora)');
    assert.equal(evo.calls[3].arg.number, ADMIN, 'resposta na conversa verificada');
    assert.equal(store.queue.stats().pending, 0);
  } finally { store.close(); w.close(); }
});

test('contrato: toda ação listada no prompt para /api/admin/* existe na API (nenhuma "invalid_action")', async () => {
  const w = world();
  try {
    const t = w.task();
    for (const [route, re] of [['/api/admin/access', /\/api\/admin\/access\s+\{"action":"([^"]+)"/], ['/api/admin/groups', /\/api\/admin\/groups\s+\{"action":"([^"]+)"/]]) {
      const actions = re.exec(docs)?.[1]?.split('|') ?? [];
      assert.ok(actions.length >= 3, `prompt não lista ações de ${route}`);
      for (const action of actions) {
        const r = await w.call(route, t.token, { action });
        assert.notEqual(r.body.error, 'invalid_action', `${route}: ação "${action}" do prompt não existe`);
      }
    }
    // o campo mode citado no prompt é o que a API de fato aceita
    assert.match(docs, /"mode":"add\|set"/);
  } finally { w.close(); }
});

test('contrato: em conversa privada as rotas de operação exigem client, e o prompt manda informá-lo', async () => {
  const w = world();
  try {
    assert.match(docs, /SEMPRE "client"/);
    const t = w.task();
    for (const [path, body] of [['/api/ops/whatsapp/poll', { name: 'q', values: ['a', 'b'] }], ['/api/ops/whatsapp/react', { reaction: '👍' }], ['/api/ops/whatsapp/ghost-mention', { text: 'x', mentioned: ['5585988887777'] }], ['/api/ops/can', { op: 'create_whatsapp_group' }]]) {
      assert.equal((await w.call(path, t.token, body)).body.error, 'client_required', `${path} sem client`);
      const ok = await w.call(path, t.token, { ...body, client: 'worki' });
      assert.notEqual(ok.body.error, 'client_required', `${path} com client`);
    }
  } finally { w.close(); }
});
