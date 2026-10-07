import test from 'node:test';
import assert from 'node:assert/strict';
import { world, fakeEvo, ADMIN, MARIA } from './helpers.js';

const GROUP = '120363000000000001@g.us';
const OTHER = '5585911112222';

test('autenticação: sem segredo/token ou com token inválido não opera; o remetente vem do token, não do corpo', async () => {
  const w = world();
  try {
    const { token } = w.task({ sender: MARIA });                       // tarefa de quem NÃO tem acesso a nada
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    assert.equal((await w.call('/api/ops/me', token, {}, { secret: null })).code, 401);
    assert.equal((await w.call('/api/ops/me', token, {}, { secret: 'errado' })).code, 401);
    assert.equal((await w.call('/api/ops/me', 'token-falso', {})).code, 401);
    assert.equal((await w.call('/api/ops/me', undefined, {})).code, 401);
    assert.equal((await w.call('/api/ops/me', token, {}, { method: 'GET' })).code, 405);
    // Maria tenta se passar pelo admin no corpo: ignorado, e as ações de admin continuam negadas.
    const r = await w.call('/api/admin/access', token, { action: 'grant', by: ADMIN, sender: ADMIN, number: MARIA, clients: ['x'], ops: ['publish_instagram'] });
    assert.equal(r.code, 403);
    assert.ok(!w.access.can(MARIA, 'publish_instagram', 'x').ok);
  } finally { w.close(); }
});

test('admin concede pelo WhatsApp: resposta traz o que ficou registrado; preparar pode, publicar não', async () => {
  const w = world();
  try {
    const admin = w.task({ sender: ADMIN });
    const g = await w.call('/api/admin/access', admin.token, { action: 'grant', number: '+5585988887777', name: 'Maria', clients: ['x'], ops: ['read_meta_insights', 'prepare_instagram_post'] });
    assert.equal(g.code, 200);
    assert.deepEqual(g.body.access.grants[0].ops, ['read_meta_insights', 'prepare_instagram_post']);
    const maria = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/can', maria.token, { op: 'prepare_instagram_post', client: 'x' })).body.allowed, true);
    const pub = await w.call('/api/ops/can', maria.token, { op: 'publish_instagram', client: 'x' });
    assert.equal(pub.body.allowed, false);
    const rec = await w.call('/api/ops/record', maria.token, { op: 'publish_instagram', client: 'x', status: 'done', evidence: 'id 123' });
    assert.equal(rec.code, 403, 'não registra operação que ela não pode fazer');
    assert.equal((await w.call('/api/admin/access', maria.token, { action: 'list' })).code, 403, 'sem manage_access não administra');
  } finally { w.close(); }
});

test('revogação vale para tarefa já na fila: próxima chamada com o token antigo falha', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    const maria = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/can', maria.token, { op: 'read_meta_insights', client: 'x' })).body.allowed, true);
    const admin = w.task({ sender: ADMIN });
    await w.call('/api/admin/access', admin.token, { action: 'revoke', number: MARIA });
    const after = await w.call('/api/ops/can', maria.token, { op: 'read_meta_insights', client: 'x' });
    assert.equal(after.code, 403); assert.equal(after.body.error, 'access_revoked');
    assert.equal(w.tasks.tasks.get(maria.t.id).state, 'revoked');
    assert.equal((await w.call('/api/task/reply', maria.token, { text: 'oi' })).code, 403);
    assert.equal(w.evo.calls.length, 0, 'nada foi enviado');
  } finally { w.close(); }
});

test('expiração durante a tarefa também bloqueia', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'], expiresAt: new Date(w.clock.t + 60_000).toISOString() });
    const maria = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/me', maria.token, {})).code, 200);
    w.clock.t += 61_000;
    assert.equal((await w.call('/api/ops/me', maria.token, {})).code, 403);
  } finally { w.close(); }
});

test('grupo: precisa estar registrado; cliente vem do grupo; admin só em conversa privada; reply vai ao grupo', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    w.access.registerGroup({ by: ADMIN, jid: GROUP, client: 'x' });
    const m = w.task({ sender: MARIA, conv: GROUP, isGroup: true });
    assert.equal((await w.call('/api/ops/me', m.token, {})).body.client, 'x');
    assert.equal((await w.call('/api/ops/can', m.token, { op: 'read_meta_insights', client: 'y' })).body.error, 'client_mismatch');
    await w.call('/api/task/reply', m.token, { text: 'pronto' });
    assert.equal(w.evo.calls[0].arg.number, GROUP, 'responde no grupo, não no privado');
    // Admin dentro do grupo não administra acessos (só em privado).
    const a = w.task({ sender: ADMIN, conv: GROUP, isGroup: true });
    assert.equal((await w.call('/api/admin/access', a.token, { action: 'list' })).body.error, 'admin_only_private');
    // Grupo removido: tarefa em andamento no grupo é bloqueada.
    w.access.removeGroup({ by: ADMIN, jid: GROUP });
    assert.equal((await w.call('/api/ops/me', m.token, {})).code, 403);
  } finally { w.close(); }
});

test('reply privado vai ao remetente verificado; estado vira replied; limite de respostas por tarefa', async () => {
  const w = world({ env: { TASK_MAX_REPLIES: '2', REPLY_PER_MINUTE: '50' } });
  try {
    const a = w.task({ sender: ADMIN });
    const r = await w.call('/api/task/reply', a.token, { text: 'olá', to: OTHER });   // `to` do corpo é ignorado
    assert.equal(r.code, 200); assert.equal(w.evo.calls[0].arg.number, ADMIN);
    assert.equal(w.tasks.tasks.get(a.t.id).state, 'replied');
    await w.call('/api/task/reply', a.token, { text: 'dois' });
    assert.equal((await w.call('/api/task/reply', a.token, { text: 'três' })).body.error, 'task_reply_limit');
    assert.equal((await w.call('/api/task/reply', a.token, { text: '   ' })).code, 422);
  } finally { w.close(); }
});

test('reply com timeout é incerto e NÃO é reenviado automaticamente; HTTP 4xx vira 502', async () => {
  const w = world({ evo: fakeEvo({ sendText: () => ({ kind: 'uncertain' }) }) });
  try {
    const a = w.task();
    const r = await w.call('/api/task/reply', a.token, { text: 'oi' });
    assert.equal(r.code, 502); assert.equal(r.body.error, 'send_uncertain');
    assert.notEqual(w.tasks.tasks.get(a.t.id).state, 'replied');
  } finally { w.close(); }
});

test('criar grupo: exige permissão; cria, verifica e informa participantes ausentes; registra se pedido', async () => {
  const evo = fakeEvo({
    createGroup: () => ({ kind: 'ok', http: 201, data: { id: GROUP, subject: 'Worki digital operação', participants: [{ id: `${ADMIN}@s.whatsapp.net` }] } }),
    findGroupInfos: () => ({ kind: 'ok', http: 200, data: { id: GROUP, subject: 'Worki digital operação', participants: [{ id: `${ADMIN}@s.whatsapp.net`, admin: 'superadmin' }, { id: `${MARIA}@s.whatsapp.net` }] } }),
  });
  const w = world({ evo });
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    const m = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/whatsapp/create-group', m.token, { client: 'x', subject: 'g', participants: [OTHER] })).code, 403);
    assert.equal(evo.calls.length, 0);

    const a = w.task({ sender: ADMIN });
    const r = await w.call('/api/ops/whatsapp/create-group', a.token, { client: 'worki', subject: 'Worki digital operação', participants: [MARIA, OTHER], includeRequester: true, register: true });
    assert.equal(r.code, 200); assert.equal(r.body.status, 'verified');
    assert.equal(r.body.result.groupJid, GROUP); assert.deepEqual(r.body.result.missing, [OTHER]);
    assert.equal(r.body.registered, true); assert.equal(w.access.group(GROUP).client, 'worki');
    assert.deepEqual(evo.calls[0].arg.participants.sort(), [ADMIN, MARIA, OTHER].sort());
    assert.equal(w.tasks.tasks.get(a.t.id).state, 'verified');
    // Repetição do mesmo pedido não cria outro grupo.
    const again = await w.call('/api/ops/whatsapp/create-group', a.token, { client: 'worki', subject: 'Worki digital operação', participants: [MARIA, OTHER], includeRequester: true });
    assert.equal(again.body.replayed, true);
    assert.equal(evo.calls.filter((c) => c.name === 'createGroup').length, 1);
    // Validações
    assert.equal((await w.call('/api/ops/whatsapp/create-group', a.token, { client: 'worki', subject: '', participants: [MARIA] })).code, 422);
    assert.equal((await w.call('/api/ops/whatsapp/create-group', a.token, { client: 'worki', subject: 's', participants: ['12'] })).code, 422);
  } finally { w.close(); }
});

test('criar grupo com timeout: não repete às cegas; reconcilia achando o grupo; sem achar, tenta de novo', async () => {
  let created = false;
  const evo = fakeEvo({
    createGroup: () => (created ? { kind: 'ok', http: 201, data: { id: GROUP, subject: 'Equipe' } } : { kind: 'uncertain' }),
    fetchAllGroups: (_a, calls) => ({ kind: 'ok', http: 200, data: created ? [{ id: GROUP, subject: 'Equipe', creation: Math.floor(w.clock.t / 1000) + 1, participants: [{ id: `${MARIA}@s.whatsapp.net` }] }] : [] }),
    findGroupInfos: () => ({ kind: 'ok', http: 200, data: { id: GROUP, subject: 'Equipe', participants: [{ id: `${MARIA}@s.whatsapp.net` }] } }),
  });
  const w = world({ evo });
  try {
    const a = w.task({ sender: ADMIN });
    const body = { client: 'worki', subject: 'Equipe', participants: [MARIA] };
    const first = await w.call('/api/ops/whatsapp/create-group', a.token, body);
    assert.equal(first.code, 504); assert.equal(w.tasks.tasks.get(a.t.id).state, 'uncertain');
    // Nada foi criado de fato: reconciliação não acha, então a nova tentativa pode criar.
    created = true;                          // agora o serviço passa a funcionar
    evo.createGroup = async () => { evo.calls.push({ name: 'createGroup' }); return { kind: 'uncertain' }; };
    const second = await w.call('/api/ops/whatsapp/create-group', a.token, body);
    assert.equal(second.code, 200); assert.equal(second.body.reconciled, true, 'achou o grupo em vez de recriar');
    assert.equal(evo.calls.filter((c) => c.name === 'createGroup').length, 1, 'não recriou');
    assert.equal(second.body.result.groupJid, GROUP);
  } finally { w.close(); }
});

test('operação sem reconciliação (enquete) com resultado incerto não é repetida', async () => {
  let n = 0;
  const evo = fakeEvo({ sendPoll: () => (n++ === 0 ? { kind: 'uncertain' } : { kind: 'ok', http: 201, data: { key: { id: 'P' } } }) });
  const w = world({ evo });
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['send_whatsapp_poll'] });
    const m = w.task({ sender: MARIA });
    const body = { client: 'x', name: 'Dia?', values: ['Seg', 'Ter'] };
    assert.equal((await w.call('/api/ops/whatsapp/poll', m.token, body)).code, 504);
    const retry = await w.call('/api/ops/whatsapp/poll', m.token, body);
    assert.equal(retry.code, 409); assert.equal(retry.body.error, 'uncertain_previous_attempt');
    assert.equal(evo.calls.filter((c) => c.name === 'sendPoll').length, 1);
  } finally { w.close(); }
});

test('enquete, reação e menção fantasma: permissão por operação, validação e alvo restrito à conversa', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['send_whatsapp_poll', 'react_whatsapp_message'] });
    w.access.registerGroup({ by: ADMIN, jid: GROUP, client: 'x' });
    const m = w.task({ sender: MARIA, conv: GROUP, isGroup: true, msgId: 'MSG9' });
    const poll = await w.call('/api/ops/whatsapp/poll', m.token, { name: 'Dia?', values: ['Seg', 'Ter'], selectableCount: 1 });
    assert.equal(poll.body.status, 'verified'); assert.equal(w.evo.calls.at(-1).arg.number, GROUP);
    assert.equal((await w.call('/api/ops/whatsapp/poll', m.token, { name: 'q', values: ['a'] })).code, 422);
    assert.equal((await w.call('/api/ops/whatsapp/poll', m.token, { name: 'q', values: ['a', 'b'], to: '120363999999999999@g.us' })).code, 403, 'grupo não registrado');
    const re = await w.call('/api/ops/whatsapp/react', m.token, { reaction: '👍' });
    assert.equal(re.body.status, 'verified');
    assert.deepEqual(w.evo.calls.at(-1).arg, { remoteJid: GROUP, messageId: 'MSG9', fromMe: false, reaction: '👍' });
    assert.equal((await w.call('/api/ops/whatsapp/ghost-mention', m.token, { text: 'aviso', everyone: true })).code, 403, 'sem mention_whatsapp_ghost');
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['mention_whatsapp_ghost'] });
    const gm = await w.call('/api/ops/whatsapp/ghost-mention', m.token, { text: 'aviso', everyone: true });
    assert.equal(gm.body.status, 'verified'); assert.equal(w.evo.calls.at(-1).arg.mentionsEveryOne, true);
    assert.equal((await w.call('/api/ops/whatsapp/ghost-mention', m.token, { text: 'x' })).body.error, 'mention_target_required');
    const priv = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/whatsapp/ghost-mention', priv.token, { client: 'x', text: 'x', everyone: true })).body.error, 'everyone_only_in_group');
  } finally { w.close(); }
});

test('registro de operação em outra plataforma: exige permissão e evidência; recusa regravar verificado como pendente', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['publish_instagram'] });
    const m = w.task({ sender: MARIA });
    const body = { op: 'publish_instagram', client: 'x', platform: 'zernio', ref: 'post-1' };
    assert.equal((await w.call('/api/ops/record', m.token, { ...body, status: 'done' })).body.error, 'evidence_required');
    assert.equal((await w.call('/api/ops/record', m.token, { ...body, status: 'started' })).code, 200);
    const done = await w.call('/api/ops/record', m.token, { ...body, status: 'verified', evidence: 'permalink https://instagram.com/p/abc' });
    assert.equal(done.body.previous, 'started');
    assert.equal(w.tasks.tasks.get(m.t.id).state, 'verified');
    assert.equal((await w.call('/api/ops/record', m.token, { ...body, status: 'started' })).code, 409);
  } finally { w.close(); }
});

test('histórico: pessoa vê só os seus pedidos; admin vê todos', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    const a = w.task({ sender: ADMIN }); const m = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/history', m.token, {})).body.tasks.length, 1);
    assert.equal((await w.call('/api/ops/history', a.token, {})).body.tasks.length, 2);
    assert.equal((await w.call('/api/admin/tasks', m.token, {})).code, 403);
    assert.equal((await w.call('/api/admin/tasks', a.token, {})).body.tasks.length, 2);
  } finally { w.close(); }
});

test('Evolution sem configuração vira 503 claro, não 500', async () => {
  const evo = fakeEvo({ sendText: () => { throw Object.assign(new Error('x'), { code: 'no_evolution' }); } });
  const w = world({ evo });
  try { const a = w.task(); assert.equal((await w.call('/api/task/reply', a.token, { text: 'oi' })).body.error, 'evolution_not_configured'); } finally { w.close(); }
});

test('logs da API não vazam texto, números, JIDs, token nem segredo', async () => {
  const lines = []; const orig = console.log; console.log = (l) => lines.push(l);
  const w = world();
  try {
    const a = w.task({ sender: ADMIN });
    await w.call('/api/task/reply', a.token, { text: 'texto privado' });
    await w.call('/api/admin/access', a.token, { action: 'grant', number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    await w.call('/api/ops/me', 'token-errado', {}); await w.call('/api/ops/me', a.token, {}, { secret: 'segredo-errado' });
    await w.call('/api/ops/whatsapp/create-group', a.token, { client: 'x', subject: 'Nome Privado', participants: [MARIA] });
  } finally { console.log = orig; w.close(); }
  const all = lines.join('\n');
  for (const bad of ['texto privado', ADMIN, MARIA, 'segredo-rotina', 'segredo-errado', 'token-errado', 'Nome Privado', GROUP]) assert.ok(!all.includes(bad), `vazou ${bad}`);
});

test('handoff: só promete humano se o aviso foi enviado de fato; sem contato configurado falha explicitamente', async () => {
  const w = world({ env: { OPERATOR_CONTACT: '+55 85 90001-0001' } });
  const semContato = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    const m = w.task({ sender: MARIA });
    assert.equal((await w.call('/api/ops/handoff', m.token, {})).code, 422);
    const r = await w.call('/api/ops/handoff', m.token, { reason: 'pedido de pagamento' });
    assert.equal(r.body.status, 'handoff'); assert.equal(w.tasks.tasks.get(m.t.id).state, 'handoff');
    assert.equal(w.evo.calls[0].arg.number, ADMIN); assert.match(w.evo.calls[0].arg.text, /pedido de pagamento/);
    assert.equal((await w.call('/api/ops/handoff', m.token, { reason: 'de novo' })).body.replayed, true);
    assert.equal(w.evo.calls.length, 1, 'não avisa duas vezes');
    const a = semContato.task({ sender: ADMIN });
    assert.equal((await semContato.call('/api/ops/handoff', a.token, { reason: 'x' })).body.error, 'handoff_not_configured');
  } finally { w.close(); semContato.close(); }
});
