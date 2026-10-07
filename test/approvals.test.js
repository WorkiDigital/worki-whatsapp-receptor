import test from 'node:test';
import assert from 'node:assert/strict';
import { world, ADMIN, MARIA } from './helpers.js';

const enabled = { DYNAMIC_APPROVAL_ENABLED: 'true', APPROVAL_TTL_SECONDS: '900' };
const payload = { client: 'worki', subject: 'Grupo autorizado', includeRequester: true };

test('pedido sensível fica bloqueado, é aprovado em privado e só executa uma vez', async () => {
  const w = world({ env: enabled });
  try {
    const original = w.task();
    const blocked = await w.call('/api/ops/whatsapp/create-group', original.token, payload);
    assert.equal(blocked.code, 428);
    assert.equal(blocked.body.error, 'approval_required');

    const requested = await w.call('/api/ops/approval', original.token, { action: 'request', op: 'create_whatsapp_group', client: 'worki', summary: 'Criar o grupo Grupo autorizado com o solicitante', payload });
    assert.equal(requested.code, 202);
    const code = requested.body.approval.code;

    const approvalTask = w.task({ n: 'approve' });
    assert.equal((await w.call('/api/admin/approvals', approvalTask.token, { action: 'approve', code })).code, 200);

    const executeTask = w.task({ n: 'execute' });
    const done = await w.call('/api/ops/whatsapp/create-group', executeTask.token, { ...payload, approvalCode: code });
    assert.equal(done.code, 200);
    assert.equal(done.body.status, 'done');
    assert.equal((await w.call('/api/ops/whatsapp/create-group', executeTask.token, { ...payload, approvalCode: code })).body.error, 'approval_used');
  } finally { w.close(); }
});

test('código não autoriza outro conteúdo, cliente ou remetente', async () => {
  const w = world({ env: enabled });
  try {
    const t = w.task();
    const req = await w.call('/api/ops/approval', t.token, { action: 'request', op: 'create_whatsapp_group', client: 'worki', summary: 'Criar grupo aprovado exatamente', payload });
    const code = req.body.approval.code;
    assert.equal((await w.call('/api/admin/approvals', w.task({ n: 'approve' }).token, { action: 'approve', code })).code, 200);
    assert.equal((await w.call('/api/ops/whatsapp/create-group', w.task({ n: 'changed' }).token, { ...payload, subject: 'Outro grupo', approvalCode: code })).body.error, 'approval_mismatch');

    w.access.grant({ by: ADMIN, number: MARIA, clients: ['worki'], ops: ['create_whatsapp_group'] });
    const other = w.task({ sender: MARIA, n: 'other' });
    assert.equal((await w.call('/api/ops/whatsapp/create-group', other.token, { ...payload, approvalCode: code })).body.error, 'approval_mismatch');
  } finally { w.close(); }
});

test('aprovação expira e decisão só existe em conversa privada de administrador', async () => {
  const w = world({ env: { DYNAMIC_APPROVAL_ENABLED: 'true', APPROVAL_TTL_SECONDS: '1' } });
  try {
    const t = w.task();
    const req = await w.call('/api/ops/approval', t.token, { action: 'request', op: 'create_whatsapp_group', client: 'worki', summary: 'Criar grupo com validade curta', payload });
    const code = req.body.approval.code;
    const groupAdmin = w.task({ isGroup: true, conv: '120363000000000001@g.us', client: 'worki', n: 'group' });
    w.access.registerGroup({ by: ADMIN, jid: groupAdmin.t.conv, client: 'worki' });
    assert.equal((await w.call('/api/admin/approvals', groupAdmin.token, { action: 'approve', code })).body.error, 'admin_only_private');
    w.clock.t += 1001;
    assert.equal((await w.call('/api/admin/approvals', w.task({ n: 'late' }).token, { action: 'approve', code })).body.error, 'approval_expired');
  } finally { w.close(); }
});

test('planejamento descreve ferramenta ausente e não executa nada', async () => {
  const w = world({ env: enabled });
  try {
    const t = w.task();
    const missing = await w.call('/api/ops/plan', t.token, { goal: 'ligar para um cliente', op: 'make_phone_call', client: 'worki' });
    assert.equal(missing.code, 200);
    assert.equal(missing.body.status, 'missing_tool');
    assert.match(missing.body.missing.required, /rota tipada/);
    assert.equal(w.evo.calls.length, 0);
    const known = await w.call('/api/ops/plan', t.token, { goal: 'criar um grupo', op: 'create_whatsapp_group', client: 'worki' });
    assert.equal(known.body.approvalRequired, true);
    assert.equal(known.body.next, '/api/ops/approval');
  } finally { w.close(); }
});

test('recurso desligado preserva o comportamento atual', async () => {
  const w = world();
  try {
    const t = w.task();
    const r = await w.call('/api/ops/whatsapp/create-group', t.token, payload);
    assert.equal(r.code, 200);
    assert.equal(r.body.status, 'done');
    assert.equal((await w.call('/api/ops/approval', t.token, {})).body.error, 'dynamic_approval_disabled');
  } finally { w.close(); }
});
