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
    assert.deepEqual(evo.calls.find((c) => c.name === 'createGroup').arg.participants.sort(), [ADMIN, MARIA, OTHER].sort());
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

test('registro: evidência obrigatória; escrita externa NÃO é certificada pelo executor; rascunho sim; verificado não regrava', async () => {
  const w = world();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['publish_instagram', 'prepare_instagram_post'] });
    const m = w.task({ sender: MARIA });
    const pub = { op: 'publish_instagram', client: 'x', platform: 'zernio', ref: 'post-1' };
    assert.equal((await w.call('/api/ops/record', m.token, { ...pub, status: 'started' })).code, 200, 'intenção pode ser registrada');
    for (const status of ['done', 'verified']) {
      const r = await w.call('/api/ops/record', m.token, { ...pub, status, evidence: 'permalink https://instagram.com/p/abc' });
      assert.equal(r.code, 409); assert.equal(r.body.error, 'mediated_only', 'o executor não certifica escrita externa');
    }
    assert.equal(w.tasks.tasks.get(m.t.id).state, 'started', 'estado não avança sem certificação');
    const draft = { op: 'prepare_instagram_post', client: 'x', platform: 'receptor', ref: 'rascunho-1' };
    assert.equal((await w.call('/api/ops/record', m.token, { ...draft, status: 'done' })).body.error, 'evidence_required');
    assert.equal((await w.call('/api/ops/record', m.token, { ...draft, status: 'verified', evidence: 'rascunho entregue na conversa' })).code, 200);
    assert.equal(w.tasks.tasks.get(m.t.id).state, 'verified');
    assert.equal((await w.call('/api/ops/record', m.token, { ...draft, status: 'started' })).code, 409);
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
  const w = world({ env: { OPERATOR_CONTACT: '+55 85 98888-0001' } });
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

test('pré-verificação: se já existe grupo com o nome, NÃO cria; se não dá para listar, NÃO cria; allowDuplicate cria mesmo assim', async () => {
  const existing = [{ id: GROUP, subject: ' worki DIGITAL operação ', owner: `${ADMIN}@s.whatsapp.net`, participants: [{ id: `${ADMIN}@s.whatsapp.net` }, { id: `${MARIA}@s.whatsapp.net` }] }];
  const w = world({ evo: fakeEvo({ fetchAllGroups: () => ({ kind: 'ok', http: 200, data: existing }) }) });
  try {
    const a = w.task({ sender: ADMIN });
    const r = await w.call('/api/ops/whatsapp/create-group', a.token, { client: 'worki', subject: 'Worki digital operação', participants: [MARIA] });
    assert.equal(r.body.status, 'exists'); assert.equal(r.body.created, false); assert.equal(r.body.result.groupJid, GROUP);
    assert.equal(w.evo.calls.filter((c) => c.name === 'createGroup').length, 0, 'não criou');
    assert.equal(w.tasks.tasks.get(a.t.id).state, 'verified');
    const dup = await w.call('/api/ops/whatsapp/create-group', w.task({ sender: ADMIN }).token, { client: 'worki', subject: 'Worki digital operação', participants: [MARIA], allowDuplicate: true });
    assert.equal(w.evo.calls.filter((c) => c.name === 'createGroup').length, 1, 'duplicado só com pedido explícito');
    assert.notEqual(dup.body.status, 'exists');
  } finally { w.close(); }
  for (const kind of ['uncertain', 'rejected']) {
    const f = world({ evo: fakeEvo({ fetchAllGroups: () => ({ kind, http: 500 }) }) });
    try {
      const r = await f.call('/api/ops/whatsapp/create-group', f.task({ sender: ADMIN }).token, { client: 'worki', subject: 'Novo', participants: [MARIA] });
      assert.equal(r.code, 503); assert.equal(r.body.error, 'preflight_failed');
      assert.equal(f.evo.calls.filter((c) => c.name === 'createGroup').length, 0, `falha fechada (${kind})`);
    } finally { f.close(); }
  }
});

test('teste do operador: somente o contato que pede + a conta que cria o grupo; qualquer extra é sinalizado', async () => {
  const OWNER = '5585911110000';
  const mk = (extra) => fakeEvo({
    createGroup: () => ({ kind: 'ok', http: 201, data: { id: GROUP, subject: 'Worki digital operação' } }),
    findGroupInfos: () => ({ kind: 'ok', http: 200, data: { id: GROUP, subject: 'Worki digital operação', owner: `${OWNER}@s.whatsapp.net`, participants: [{ id: `${OWNER}@s.whatsapp.net`, admin: 'superadmin' }, { id: `${ADMIN}@s.whatsapp.net` }, ...extra] } }),
  });
  for (const [extra, want] of [[[], []], [[{ id: `${OTHER}@s.whatsapp.net` }], [OTHER]]]) {
    const evo = mk(extra); const w = world({ evo });
    try {
      const r = await w.call('/api/ops/whatsapp/create-group', w.task({ sender: ADMIN }).token, { client: 'worki', subject: 'Worki digital operação', includeRequester: true });
      assert.equal(r.body.status, 'verified');
      assert.deepEqual(evo.calls.find((c) => c.name === 'createGroup').arg.participants, [ADMIN], 'só o contato de quem pediu');
      assert.deepEqual(r.body.result.unexpected, want); assert.deepEqual(r.body.result.missing, []);
    } finally { w.close(); }
  }
});

test('Evolution 2.3.7: resolve participante @lid por phoneNumber e não trata o superadmin @lid como inesperado', async () => {
  const ownerPhone = '5511999990001';
  const requested = '5511999990002';
  const unexpected = '5511999990003';
  const make = (participants) => fakeEvo({
    createGroup: () => ({ kind: 'ok', http: 201, data: { id: GROUP, subject: 'Operação teste' } }),
    findGroupInfos: () => ({ kind: 'ok', http: 200, data: {
      id: GROUP, subject: 'Operação teste', owner: 'owner-private@lid', participants,
    } }),
  });
  const run = async (participants) => {
    const w = world({ evo: make(participants) });
    try {
      const t = w.task({ sender: ADMIN });
      return await w.call('/api/ops/whatsapp/create-group', t.token, { client: 'worki', subject: 'Operação teste', participants: [requested] });
    } finally { w.close(); }
  };
  const present = await run([
    { id: 'owner-private@lid', phoneNumber: ownerPhone, admin: 'superadmin' },
    { id: 'requested-private@lid', phoneNumber: requested, admin: null },
  ]);
  assert.deepEqual(present.body.result.missing, []);
  assert.deepEqual(present.body.result.unexpected, []);

  const absent = await run([{ id: 'owner-private@lid', admin: 'superadmin' }]);
  assert.deepEqual(absent.body.result.missing, [requested]);
  assert.deepEqual(absent.body.result.unexpected, []);

  const extra = await run([
    { id: 'owner-private@lid', admin: 'superadmin' },
    { id: 'unexpected-private@lid', phoneNumber: unexpected, admin: null },
  ]);
  assert.deepEqual(extra.body.result.missing, [requested]);
  assert.deepEqual(extra.body.result.unexpected, [unexpected]);

  const normal = await run([
    { id: `${ownerPhone}@s.whatsapp.net`, admin: 'superadmin' },
    { id: `${requested}@s.whatsapp.net`, admin: null },
  ]);
  assert.deepEqual(normal.body.result.missing, []);
  assert.deepEqual(normal.body.result.unexpected, []);
});

test('rotação sem parada: SEND_SECRET_NEXT e EVOLUTION_WEBHOOK_SECRET_NEXT valem junto do principal', async () => {
  const w = world({ env: { SEND_SECRET: 'antigo', SEND_SECRET_NEXT: 'novo' } });
  try {
    const t = w.task({ sender: ADMIN });
    assert.equal((await w.call('/api/ops/me', t.token, {}, { secret: 'antigo' })).code, 200);
    assert.equal((await w.call('/api/ops/me', t.token, {}, { secret: 'novo' })).code, 200);
    assert.equal((await w.call('/api/ops/me', t.token, {}, { secret: 'outro' })).code, 401);
  } finally { w.close(); }
  const { createHandler } = await import('../lib/handler.js');
  const h = createHandler({ env: { EVOLUTION_WEBHOOK_SECRET: 'a', EVOLUTION_WEBHOOK_SECRET_NEXT: 'b', ALLOWED_CLIENTS: 'worki' }, dedup: { check: () => false }, waitUntil: (p) => p, forward: async () => 200 });
  const code = (sec) => new Promise((resolve) => { h({ method: 'POST', headers: { 'x-webhook-secret': sec }, query: { client: 'worki' }, body: { event: 'qrcode.updated' } }, { status(c) { this.c = c; return this; }, json() { resolve(this.c); } }); });
  assert.equal(await code('a'), 200); assert.equal(await code('b'), 200); assert.equal(await code('c'), 401);
});
