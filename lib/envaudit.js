import { createHash } from 'node:crypto';

// Auditoria do ambiente do serviço SEM imprimir valores. Entrada: texto "CHAVE=valor" por linha (formato do EasyPanel)
// ou process.env. Saída: situação por variável (presente/ausente/duplicada, tamanho, impressão digital curta para
// provar que um valor MUDOU numa rotação) e problemas. Impressão digital = 6 primeiros hex do SHA-256.
const SECRETS = ['EVOLUTION_WEBHOOK_SECRET', 'SEND_SECRET', 'FORWARD_TOKEN', 'EVOLUTION_API_KEY', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'ZERNIO_API_KEY'];
const REQUIRED = ['EVOLUTION_WEBHOOK_SECRET', 'ALLOWED_CLIENTS', 'SEND_SECRET', 'PUBLIC_BASE_URL', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_INSTANCE', 'FORWARD_URL', 'FORWARD_TOKEN'];
const fp = (v) => createHash('sha256').update(v).digest('hex').slice(0, 6);

export function parseEnvText(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.push({ key: m[1], value: m[2] });
  }
  return out;
}

export function auditEnv(entries) {
  const by = new Map();
  for (const e of entries) { if (!by.has(e.key)) by.set(e.key, []); by.get(e.key).push(e.value); }
  const problems = []; const rows = [];
  for (const [key, vals] of by) {
    const distinct = new Set(vals);
    if (vals.length > 1) problems.push(`${key}: definida ${vals.length}x${distinct.size > 1 ? ' com valores DIFERENTES (qual vale depende do runtime)' : ''}`);
    const last = vals[vals.length - 1];
    rows.push({ key, count: vals.length, length: last.length, fp: SECRETS.includes(key) || key.endsWith('_NEXT') ? fp(last) : undefined });
  }
  const get = (k) => by.get(k)?.at(-1);
  for (const k of ['HISTORY_ENABLED', 'GROUP_REQUIRE_MENTION', 'UNKNOWN_ALERT_ENABLED', 'GROUP_ALERT_ENABLED', 'ALERT_INCLUDE_TEXT', 'WRITE_GITHUB_ENABLED', 'WRITE_VERCEL_ENABLED', 'WRITE_ZERNIO_ENABLED']) if (get(k) !== undefined && !['true', 'false'].includes(get(k))) problems.push(`${k}: use true ou false`);
  if (get('GROUP_REQUIRE_MENTION') === 'true' && !get('AGENT_NUMBER')) problems.push('AGENT_NUMBER ausente: filtro depende do sender do webhook; /health avisa self_unknown enquanto não identificado');
  for (const k of ['HISTORY_MESSAGES', 'HISTORY_MAX_AGE_HOURS', 'ALERT_PER_HOUR']) if (get(k) !== undefined && (!Number.isSafeInteger(Number(get(k))) || Number(get(k)) <= 0)) problems.push(`${k}: exige inteiro positivo`);
  if (get('UNKNOWN_ALERT_ENABLED') === 'true' && !get('OPERATOR_CONTACT')) problems.push('UNKNOWN_ALERT_ENABLED exige OPERATOR_CONTACT');
  if (get('GROUP_ALERT_ENABLED') === 'true' && !get('OPERATOR_CONTACT')) problems.push('GROUP_ALERT_ENABLED exige OPERATOR_CONTACT');
  for (const k of REQUIRED) if (!get(k)) problems.push(`${k}: ausente ou vazia`);
  if (!get('ADMIN_SENDERS') && !get('ALLOWED_SENDERS')) problems.push('ADMIN_SENDERS ausente (nenhum administrador inicial)');
  if (!get('OPERATOR_CONTACT')) problems.push('OPERATOR_CONTACT ausente (handoff humano não funciona)');
  for (const k of ['EVOLUTION_WEBHOOK_SECRET', 'SEND_SECRET']) { const v = get(k); if (v && v.length < 32) problems.push(`${k}: curta (<32)`); }
  const seen = new Map();
  for (const k of SECRETS) { const v = get(k); if (!v) continue; const f = fp(v); if (seen.has(f)) problems.push(`${k} e ${seen.get(f)} têm o MESMO valor (cada fluxo precisa de credencial própria)`); else seen.set(f, k); }
  const fu = get('FORWARD_URL'); if (fu && !/^https:\/\//.test(fu)) problems.push('FORWARD_URL não é HTTPS');
  const pb = get('PUBLIC_BASE_URL'); if (pb && !/^https:\/\//.test(pb)) problems.push('PUBLIC_BASE_URL não é HTTPS');
  if (get('REPLY_ENABLED') !== undefined && get('REPLY_ENABLED') !== 'true') problems.push('REPLY_ENABLED diferente de true: respostas desligadas');
  for (const [k, vals] of by) if (vals.some((v) => /^(changeme|xxx+|seu[-_]|<.*>|cole)/i.test(v))) problems.push(`${k}: parece placeholder`);
  return { ok: !problems.length, problems, rows };
}
