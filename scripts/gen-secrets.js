#!/usr/bin/env node
// Gera segredos novos para a rotação e grava num arquivo 0600 FORA do repositório. Nunca imprime os valores:
// só nomes, tamanho e impressão digital (para conferir depois que o valor mudou).
// Uso: node scripts/gen-secrets.js <arquivo-fora-do-git> [NOME ...]   (padrão: SEND_SECRET EVOLUTION_WEBHOOK_SECRET)
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const [file, ...names] = process.argv.slice(2);
if (!file) { console.error('uso: gen-secrets.js <arquivo> [NOME ...]'); process.exit(2); }
const out = resolve(file);
if (existsSync(out)) { console.error('recusado: o arquivo já existe'); process.exit(1); }
try {
  const top = execFileSync('git', ['-C', resolve(out, '..'), 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (top) { console.error('recusado: o arquivo ficaria dentro de um repositório Git'); process.exit(1); }
} catch { /* fora de repositório: ok */ }
const keys = names.length ? names : ['SEND_SECRET', 'EVOLUTION_WEBHOOK_SECRET'];
const lines = keys.map((k) => `${k}=${randomBytes(32).toString('hex')}`);
writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
for (const l of lines) { const [k, v] = l.split('='); console.log(`${k}  len=${v.length}  fp=${createHash('sha256').update(v).digest('hex').slice(0, 6)}`); }
console.log(`gravado em ${out} (0600). Apague depois de aplicar.`);
