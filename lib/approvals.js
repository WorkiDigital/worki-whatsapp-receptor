import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Journal } from './journal.js';

const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const code = () => `A-${randomBytes(4).toString('hex').toUpperCase()}`;
const safeCode = (value) => /^A-[A-F0-9]{8}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : null;

export const SENSITIVE_OPERATIONS = Object.freeze([
  'publish_instagram', 'create_meta_campaign_paused', 'activate_meta_campaign',
  'send_email', 'deploy_vercel_preview', 'deploy_vercel_production', 'edit_repo',
  'send_whatsapp_group', 'create_whatsapp_group', 'send_whatsapp_poll',
  'react_whatsapp_message', 'mention_whatsapp_ghost',
]);

// Hash canônico do conteúdo que será executado. Campos de transporte não participam:
// um código só serve para o mesmo cliente, operação e parâmetros concretos.
export function actionDigest(operation, client, payload = {}) {
  const clean = Object.fromEntries(Object.entries(payload)
    .filter(([k]) => !['approvalCode', 'client', 'idempotencyKey'].includes(k))
    .sort(([a], [b]) => a.localeCompare(b)));
  return sha(JSON.stringify([operation, client, clean]));
}

export class ApprovalStore {
  constructor({ dir, now = Date.now, ttlMs = 15 * 60_000 } = {}) {
    this.now = now; this.ttlMs = ttlMs; this.rows = new Map();
    this.journal = new Journal(join(dir, 'approvals.jsonl'));
    this.journal.open((r) => this.#apply(r));
  }

  #apply(r) {
    if (r.t === 'request') this.rows.set(r.code, { ...r, status: 'pending' });
    else if (r.t === 'decision' || r.t === 'consume') {
      const row = this.rows.get(r.code);
      if (row) Object.assign(row, r.t === 'decision' ? { status: r.status, decidedAt: r.at, decidedBy: r.by } : { status: 'used', usedAt: r.at, usedBy: r.by });
    }
  }

  #write(r) { const rec = { ...r, at: this.now() }; this.journal.append(rec); this.#apply(rec); return rec; }

  request({ sender, client, operation, digest, summary }) {
    const requester = sha(sender);
    const existing = [...this.rows.values()].find((r) => r.requester === requester && r.client === client && r.operation === operation && r.digest === digest && r.status === 'pending' && r.expiresAt > this.now());
    if (existing) return this.view(existing);
    let id; do { id = code(); } while (this.rows.has(id));
    this.#write({ t: 'request', code: id, requester, client, operation, digest, summary: String(summary || '').trim().slice(0, 240), expiresAt: this.now() + this.ttlMs });
    return this.view(this.rows.get(id));
  }

  decide({ code: value, approved, by }) {
    const id = safeCode(value); const row = id && this.rows.get(id);
    if (!row) return { error: 'approval_not_found' };
    if (row.expiresAt <= this.now()) return { error: 'approval_expired' };
    if (row.status !== 'pending') return { error: 'approval_not_pending', status: row.status };
    this.#write({ t: 'decision', code: id, status: approved ? 'approved' : 'denied', by: sha(by) });
    return { approval: this.view(this.rows.get(id)) };
  }

  authorize({ code: value, sender, client, operation, digest }) {
    const id = safeCode(value); const row = id && this.rows.get(id);
    if (!row) return { ok: false, error: 'approval_required' };
    if (row.expiresAt <= this.now()) return { ok: false, error: 'approval_expired' };
    if (row.status !== 'approved') return { ok: false, error: row.status === 'used' ? 'approval_used' : 'approval_not_approved' };
    if (row.requester !== sha(sender) || row.client !== client || row.operation !== operation || row.digest !== digest) return { ok: false, error: 'approval_mismatch' };
    this.#write({ t: 'consume', code: id, by: sha(sender) });
    return { ok: true, approval: this.view(this.rows.get(id)) };
  }

  list({ status, limit = 20 } = {}) {
    return [...this.rows.values()].filter((r) => !status || r.status === status)
      .sort((a, b) => b.at - a.at).slice(0, Math.min(Number(limit) || 20, 100)).map((r) => this.view(r));
  }

  stats() {
    const out = {};
    for (const row of this.rows.values()) { const status = row.expiresAt <= this.now() && row.status === 'pending' ? 'expired' : row.status; out[status] = (out[status] || 0) + 1; }
    return out;
  }

  view(r) { return { code: r.code, client: r.client, operation: r.operation, summary: r.summary, status: r.expiresAt <= this.now() && r.status === 'pending' ? 'expired' : r.status, requestedAt: r.at, expiresAt: r.expiresAt }; }
  close() { this.journal.close(); }
}
