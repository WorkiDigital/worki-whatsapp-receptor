#!/usr/bin/env node
// Uso: node scripts/backup.js create [--data /data] [--out /data/backups/<carimbo>]
//      node scripts/backup.js verify <dir>
//      node scripts/backup.js restore <dir> [--data /data] [--confirm]
// Imprime só nomes, tamanhos, hashes e contagens; nunca conteúdo dos diários.
import { createBackup, verifyBackup, restoreBackup } from '../lib/backup.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const pos = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--confirm'));
const data = flag('--data', process.env.DATA_DIR || '/data');
try {
  if (cmd === 'create') {
    const out = flag('--out', `${data}/backups/${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const m = createBackup({ dataDir: data, outDir: out });
    console.log(JSON.stringify({ out, files: m.files, counts: m.counts }, null, 2));
  } else if (cmd === 'verify') {
    const v = verifyBackup(pos);
    console.log(JSON.stringify({ ok: v.ok, problems: v.problems, counts: v.manifest?.counts }, null, 2));
    process.exit(v.ok ? 0 : 1);
  } else if (cmd === 'restore') {
    console.log(JSON.stringify(restoreBackup({ backupDir: pos, dataDir: data, confirm: rest.includes('--confirm') }), null, 2));
  } else { console.error('uso: backup.js create|verify|restore'); process.exit(2); }
} catch (e) { console.error(`erro: ${e.message}`); process.exit(1); }
