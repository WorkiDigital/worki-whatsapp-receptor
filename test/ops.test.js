import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBackup, verifyBackup, restoreBackup } from '../lib/backup.js';
import { auditEnv, parseEnvText } from '../lib/envaudit.js';
import { world, ADMIN, MARIA } from './helpers.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ops-'));

function populated() {
  const w = world();
  w.access.grant({ by: ADMIN, number: MARIA, name: 'Maria', clients: ['x'], ops: ['read_meta_insights'] });
  w.access.registerGroup({ by: ADMIN, jid: '120363000000000001@g.us', client: 'x' });
  const t = w.task({ sender: MARIA });
  w.tasks.recordOp({ taskId: t.t.id, key: 'k', op: 'read_meta_insights', status: 'verified', evidence: 'ok' });
  w.tasks.setState(t.t.id, 'replied');
  return w;
}

test('backup: cria, verifica, reproduz as contagens e detecta adulteração, arquivo faltando e arquivo extra', () => {
  const w = populated(); const out = join(tmp(), 'bk'); const root = tmp();
  try {
    appendFileSync(join(w.dir, 'tasks.jsonl'), '{"t":"state","id":"parcial');          // cauda parcial: fora do backup
    const m = createBackup({ dataDir: w.dir, outDir: out });
    assert.equal(m.counts.people, 1); assert.equal(m.counts.groups, 1); assert.equal(m.counts.tasks, 1); assert.equal(m.counts.ops, 1);
    assert.ok(m.files.find((f) => f.name === 'tasks.jsonl').truncatedTailBytes > 0, 'tail parcial registrado');
    assert.equal(statSync(join(out, 'access.jsonl')).mode & 0o777, 0o600);
    assert.deepEqual(verifyBackup(out).problems, []);
    assert.throws(() => createBackup({ dataDir: w.dir, outDir: out }), /não está vazio/);
    appendFileSync(join(out, 'access.jsonl'), '\n');                                    // adulterado
    assert.ok(verifyBackup(out).problems.some((p) => /hash|tamanho/.test(p)));
    rmSync(join(out, 'tasks.jsonl')); assert.ok(verifyBackup(out).problems.some((p) => /ausente/.test(p)));
    writeFileSync(join(out, 'extra.txt'), 'x'); assert.ok(verifyBackup(out).problems.some((p) => /fora do manifesto/.test(p)));
    assert.equal(verifyBackup(root).ok, false);
  } finally { w.close(); rmSync(out, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test('restauração: exige --confirm com dados presentes, preserva o estado atual, confere as contagens e recusa servidor ativo', () => {
  const w = populated(); const bk = join(tmp(), 'bk'); const target = tmp();
  try {
    createBackup({ dataDir: w.dir, outDir: bk });
    // alvo vazio: restaura direto
    const r = restoreBackup({ backupDir: bk, dataDir: target });
    assert.equal(r.counts.people, 1); assert.equal(r.preservedAt, null);
    // alvo com dados: precisa de confirm e preserva o atual
    assert.throws(() => restoreBackup({ backupDir: bk, dataDir: target }), /--confirm/);
    writeFileSync(join(target, 'access.jsonl'), '{"t":"person","number":"5585900000009","name":"Novo"}\n');
    const r2 = restoreBackup({ backupDir: bk, dataDir: target, confirm: true });
    assert.ok(existsSync(join(r2.preservedAt, 'access.jsonl')));
    assert.equal(r2.counts.people, 1);
    // servidor ativo (lock com pid vivo = este processo)
    writeFileSync(join(target, 'queue.lock'), String(process.pid));
    assert.throws(() => restoreBackup({ backupDir: bk, dataDir: target, confirm: true }), /ativo/);
    // backup adulterado não restaura
    appendFileSync(join(bk, 'access.jsonl'), '\n');
    assert.throws(() => restoreBackup({ backupDir: bk, dataDir: tmp(), confirm: true }), /backup inválido/);
  } finally { w.close(); rmSync(bk, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test('CLI do backup: create/verify imprimem contagens e hashes, nunca conteúdo', () => {
  const w = populated(); const out = join(tmp(), 'cli');
  try {
    const c = spawnSync(process.execPath, ['scripts/backup.js', 'create', '--data', w.dir, '--out', out], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const v = spawnSync(process.execPath, ['scripts/backup.js', 'verify', out], { encoding: 'utf8' });
    assert.equal(v.status, 0); assert.equal(JSON.parse(v.stdout).ok, true);
    for (const bad of [MARIA, ADMIN, 'Maria', '120363000000000001']) assert.ok(!(c.stdout + v.stdout).includes(bad), `vazou ${bad}`);
    writeFileSync(join(out, 'journal.jsonl'), 'x\n');
    assert.equal(spawnSync(process.execPath, ['scripts/backup.js', 'verify', out], { encoding: 'utf8' }).status, 1);
  } finally { w.close(); rmSync(out, { recursive: true, force: true }); }
});

const GOOD = [
  'EVOLUTION_WEBHOOK_SECRET=' + 'a'.repeat(40), 'ALLOWED_CLIENTS=worki', 'SEND_SECRET=' + 'b'.repeat(40), 'PUBLIC_BASE_URL=https://r.exemplo.com',
  'EVOLUTION_API_URL=https://evo.exemplo.com', 'EVOLUTION_API_KEY=' + 'c'.repeat(36), 'EVOLUTION_INSTANCE=worki-claude-teste',
  'FORWARD_URL=https://api.anthropic.com/v1/claude_code/routines/trig_x/fire', 'FORWARD_TOKEN=' + 'd'.repeat(50), 'ADMIN_SENDERS=5585988880001',
  'OPERATOR_CONTACT=5585988880001', 'REPLY_ENABLED=true',
].join('\n');

test('env-audit: aceita ambiente correto; acusa duplicata com valores diferentes, segredos iguais, ausentes, curtos, http e placeholder', () => {
  assert.deepEqual(auditEnv(parseEnvText(GOOD)).problems, []);
  const bad = auditEnv(parseEnvText(`${GOOD}\nSEND_SECRET=${'z'.repeat(40)}`));
  assert.ok(bad.problems.some((p) => /SEND_SECRET: definida 2x com valores DIFERENTES/.test(p)));
  assert.ok(auditEnv(parseEnvText(GOOD.replace('d'.repeat(50), 'b'.repeat(40)))).problems.some((p) => /MESMO valor/.test(p)));
  assert.ok(auditEnv(parseEnvText(GOOD.replace(/^SEND_SECRET=.*$/m, ''))).problems.some((p) => /SEND_SECRET: ausente/.test(p)));
  assert.ok(auditEnv(parseEnvText(GOOD.replace('b'.repeat(40), 'curta'))).problems.some((p) => /curta/.test(p)));
  assert.ok(auditEnv(parseEnvText(GOOD.replace('https://r.exemplo.com', 'http://r.exemplo.com'))).problems.some((p) => /PUBLIC_BASE_URL não é HTTPS/.test(p)));
  assert.ok(auditEnv(parseEnvText(GOOD.replace('worki-claude-teste', '<instancia>'))).problems.some((p) => /placeholder/.test(p)));
  assert.ok(auditEnv(parseEnvText(GOOD.replace(/^OPERATOR_CONTACT=.*$/m, ''))).problems.some((p) => /OPERATOR_CONTACT/.test(p)));
});

test('env-audit e gen-secrets (CLI): não imprimem valores; gen-secrets grava 0600 e recusa sobrescrever e repositório Git', () => {
  const dir = tmp(); const f = join(dir, 'novos.env');
  try {
    const a = spawnSync(process.execPath, ['scripts/env-audit.js'], { input: `${GOOD}\nSEND_SECRET=${'z'.repeat(40)}`, encoding: 'utf8' });
    assert.equal(a.status, 1); assert.match(a.stdout, /fp=[0-9a-f]{6}/);
    for (const v of ['a'.repeat(40), 'b'.repeat(40), 'z'.repeat(40), 'd'.repeat(50), 'c'.repeat(36)]) assert.ok(!a.stdout.includes(v), 'vazou valor');
    const g = spawnSync(process.execPath, ['scripts/gen-secrets.js', f], { encoding: 'utf8' });
    assert.equal(g.status, 0, g.stderr);
    const content = readFileSync(f, 'utf8'); assert.equal(statSync(f).mode & 0o777, 0o600);
    for (const line of content.trim().split('\n')) { const [k, v] = line.split('='); assert.equal(v.length, 64); assert.ok(!g.stdout.includes(v), `imprimiu ${k}`); }
    assert.equal(spawnSync(process.execPath, ['scripts/gen-secrets.js', f], { encoding: 'utf8' }).status, 1, 'não sobrescreve');
    assert.equal(spawnSync(process.execPath, ['scripts/gen-secrets.js', join(process.cwd(), 'seg.env')], { encoding: 'utf8' }).status, 1, 'recusa dentro do repositório');
    assert.ok(!existsSync(join(process.cwd(), 'seg.env')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
