import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessStore } from './access.js';
import { TaskStore } from './tasks.js';
import { DurableQueue } from './queue.js';

// Backup verificável de DATA_DIR. Os diários são append-only: o instantâneo corta no último "\n" (sem linha parcial),
// grava hash e tamanho por arquivo e, principalmente, REPRODUZ o conteúdo (acessos, tarefas, fila) num diretório
// temporário para provar que o backup é legível e conferir as contagens. Nunca imprime conteúdo.
export const FILES = ['journal.jsonl', 'access.jsonl', 'tasks.jsonl', 'history.jsonl', 'alerts.jsonl', 'mediated.jsonl', 'resources.json'];
const sha = (b) => createHash('sha256').update(b).digest('hex');

export function replayCounts(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'bk-replay-'));
  try {
    for (const f of FILES) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(tmp, f));
    const access = new AccessStore({ dir: tmp, admins: [] });
    const tasks = new TaskStore({ dir: tmp });
    const q = new DurableQueue({ dir: tmp });
    const c = {
      people: access.people.size,
      grants: [...access.people.values()].reduce((n, p) => n + p.grants.length, 0),
      groups: access.listGroups().length,
      tasks: tasks.tasks.size, ops: tasks.ops.size,
      queue: q.stats(), corruptLines: access.journal.corruptLines + tasks.journal.corruptLines + q.corruptLines,
    };
    access.close(); tasks.close(); q.close();
    return c;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function createBackup({ dataDir, outDir, now = Date.now }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  if (readdirSync(outDir).length) throw new Error('destino do backup não está vazio');
  const files = [];
  for (const f of FILES) {
    const p = join(dataDir, f);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p);
    const end = raw.lastIndexOf(0x0a) + 1;           // só linhas completas
    const buf = raw.subarray(0, end);
    writeFileSync(join(outDir, f), buf, { mode: 0o600 });
    files.push({ name: f, bytes: buf.length, sha256: sha(buf), lines: buf.toString('utf8').split('\n').filter(Boolean).length, truncatedTailBytes: raw.length - end });
  }
  const counts = replayCounts(outDir);
  const manifest = { version: 1, createdAt: new Date(now()).toISOString(), files, counts };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

// Retorna { ok, problems[], manifest }. Confere hashes, tamanhos e as contagens obtidas por reprodução.
export function verifyBackup(dir) {
  const problems = [];
  if (!existsSync(join(dir, 'manifest.json'))) return { ok: false, problems: ['manifest.json ausente'] };
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const f of manifest.files) {
    const p = join(dir, f.name);
    if (!existsSync(p)) { problems.push(`${f.name}: ausente`); continue; }
    const b = readFileSync(p);
    if (b.length !== f.bytes) problems.push(`${f.name}: tamanho diferente`);
    if (sha(b) !== f.sha256) problems.push(`${f.name}: hash diferente`);
  }
  const extra = readdirSync(dir).filter((n) => n !== 'manifest.json' && !manifest.files.some((f) => f.name === n));
  if (extra.length) problems.push(`arquivos fora do manifesto: ${extra.join(', ')}`);
  if (!problems.length) {
    const c = replayCounts(dir);
    if (JSON.stringify(c) !== JSON.stringify(manifest.counts)) problems.push('contagens da reprodução diferem do manifesto');
  }
  return { ok: !problems.length, problems, manifest };
}

// Restaura com segurança: verifica antes, recusa com o servidor ativo, guarda o estado atual ao lado e confere depois.
export function restoreBackup({ backupDir, dataDir, confirm = false, now = Date.now }) {
  const v = verifyBackup(backupDir);
  if (!v.ok) throw new Error(`backup inválido: ${v.problems.join('; ')}`);
  const lock = join(dataDir, 'queue.lock');
  if (existsSync(lock)) {
    let alive = false;
    try { process.kill(Number(readFileSync(lock, 'utf8')), 0); alive = true; } catch { alive = false; }
    if (alive) throw new Error('o servidor parece ativo (queue.lock com processo vivo): pare o serviço antes de restaurar');
  }
  const present = FILES.filter((f) => existsSync(join(dataDir, f)));
  if (present.length && !confirm) throw new Error(`já existem dados em ${dataDir}; repita com --confirm (o estado atual é preservado em pre-restore-*)`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let aside = null;
  if (present.length) {
    aside = join(dataDir, `pre-restore-${now()}`);
    mkdirSync(aside, { mode: 0o700 });
    for (const f of present) renameSync(join(dataDir, f), join(aside, f));
  }
  for (const f of v.manifest.files) cpSync(join(backupDir, f.name), join(dataDir, f.name));
  const after = replayCounts(dataDir);
  if (JSON.stringify(after) !== JSON.stringify(v.manifest.counts)) throw new Error('restauração não confere com o manifesto');
  return { restored: v.manifest.files.map((f) => f.name), preservedAt: aside, counts: after };
}
