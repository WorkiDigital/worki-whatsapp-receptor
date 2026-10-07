// Modo VPS: servidor real em porta efêmera, fila durável em disco temporário.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createStore, drain } from '../lib/store.js';

const SEC = 'segredo-vps-teste';
const up = (id, extra = {}) => ({ event: 'messages.upsert', data: { key: { remoteJid: '5500000000000@s.whatsapp.net', fromMe: false, id, ...extra }, message: { conversation: 'texto privado' }, messageType: 'conversation' } });
const req = (port, path, { method = 'POST', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b ? JSON.parse(b) : {} })); });
  r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
});
async function boot(dir, port, extraEnv = {}) {
  const p = spawn(process.execPath, ['server.js'], { env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir, EVOLUTION_WEBHOOK_SECRET: SEC, ALLOWED_CLIENTS: 'acme', HOST: '127.0.0.1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !out.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  return { p, out: () => out, stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); }) };
}

test('servidor: 401 sem segredo; mensagem 202; duplicada 200 (inclusive após reinício); QR/conexão/fromMe não entram na fila', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcv-')); const port = 38000 + Math.floor(Math.random() * 1000);
  let s = await boot(dir, port); const H = { 'X-Webhook-Secret': SEC };
  try {
    assert.equal((await req(port, '/api/evolution/acme', { body: up('A') })).code, 401);
    assert.equal((await req(port, '/api/evolution/acme', { headers: H, body: up('A') })).body.status, 'accepted');
    assert.equal((await req(port, '/api/evolution/acme', { headers: H, body: up('A') })).body.status, 'duplicate');
    for (const b of [{ event: 'qrcode.updated', data: {} }, { event: 'connection.update', data: { state: 'open' } }, up('B', { fromMe: true })]) assert.equal((await req(port, '/api/evolution/acme', { headers: H, body: b })).code, 200);
    assert.equal((await req(port, '/health', { method: 'GET' })).body.pending, 1);
    await s.stop();
    s = await boot(dir, port);
    assert.equal((await req(port, '/api/evolution/acme', { headers: H, body: up('A') })).body.status, 'duplicate', 'dedup sobrevive ao reinício');
    assert.equal((await req(port, '/health', { method: 'GET' })).body.pending, 1, 'pendente sobrevive ao reinício');
    const logs = s.out();
    for (const bad of ['texto privado', '5500000000000', SEC]) assert.ok(!logs.includes(bad), `log vazou ${bad}`);
  } finally { await s.stop(); rmSync(dir, { recursive: true }); }
});

test('worker: entrega pendentes, repete em falha e registra falha definitiva', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcv-'));
  const st = createStore(dir, { backoffMs: 0, maxAttempts: 2 });
  try {
    st.enqueue({ client: 'acme', msg: { msgId: '1', conversationId: 'c', senderId: 's', type: 't', text: 'x' } });
    st.enqueue({ client: 'acme', msg: { msgId: '2', conversationId: 'd', senderId: 's', type: 't', text: 'y' } });
    const got = [];
    await drain(st.queue, async (ev) => { if (ev.conv === 'd') throw new Error('falha'); got.push(ev.payload.text); });
    await drain(st.queue, async () => { throw new Error('falha'); });
    assert.deepEqual(got, ['x']);
    assert.deepEqual(st.queue.stats(), { pending: 0, done: 1, failed: 1 });
  } finally { st.close(); rmSync(dir, { recursive: true }); }
});

test('servidor: rotas da API exigem segredo e token da tarefa; /health mostra tarefas; admin do ambiente vem de ADMIN_SENDERS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rcv-')); const port = 39000 + Math.floor(Math.random() * 1000);
  const s = await boot(dir, port, { SEND_SECRET: 'seg-rotina', ADMIN_SENDERS: '5585992494552' });
  try {
    assert.equal((await req(port, '/api/ops/me', { body: {} })).code, 401);
    assert.equal((await req(port, '/api/ops/me', { headers: { 'X-Send-Secret': 'seg-rotina', Authorization: 'Bearer falso' }, body: {} })).code, 401);
    assert.equal((await req(port, '/api/admin/access', { headers: { 'X-Send-Secret': 'seg-rotina' }, body: { action: 'list' } })).code, 401);
    assert.equal((await req(port, '/api/ops/inexistente', { headers: { 'X-Send-Secret': 'seg-rotina' }, body: {} })).code, 404);
    const h = (await req(port, '/health', { method: 'GET' })).body;
    assert.equal(h.ok, true); assert.deepEqual(h.tasks, {}); assert.equal(h.stalled, 0);
  } finally { await s.stop(); rmSync(dir, { recursive: true }); }
});
