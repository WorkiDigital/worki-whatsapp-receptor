#!/usr/bin/env node
// Uso: node scripts/env-audit.js <arquivo-com-CHAVE=valor>   |   cat env.txt | node scripts/env-audit.js
// Nunca imprime valores (só tamanho e impressão digital de 6 hex dos segredos).
import { readFileSync } from 'node:fs';
import { auditEnv, parseEnvText } from '../lib/envaudit.js';

const file = process.argv[2];
const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const r = auditEnv(parseEnvText(text));
for (const x of r.rows) console.log(`${x.key.padEnd(28)} x${x.count}  len=${String(x.length).padEnd(4)}${x.fp ? `  fp=${x.fp}` : ''}`);
console.log(r.ok ? '\nOK' : `\nPROBLEMAS:\n- ${r.problems.join('\n- ')}`);
process.exit(r.ok ? 0 : 1);
