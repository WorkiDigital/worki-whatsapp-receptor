import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Journal } from './journal.js';
import { numberOf, registrable, variants } from './numbers.js';
import { positive } from './history.js';

export class Alerts {
  constructor({ dir, env = {}, now = Date.now, log = () => {} }) {
    this.enabled = env.UNKNOWN_ALERT_ENABLED === 'true' || env.GROUP_ALERT_ENABLED === 'true'; this.env = env; this.now = now; this.log = log;
    this.limit = positive(env.ALERT_PER_HOUR, 5); this.rows = [];
    if (!this.enabled) return;
    this.journal = new Journal(join(dir, 'alerts.jsonl'));
    this.journal.open((r) => { if (typeof r.key === 'string' && Number.isFinite(r.at)) this.rows.push(r); });
    this.compact();
    this.timer = setInterval(() => { try { this.compact(); } catch { this.log('alert_failed', { code: 'storage_error' }); } }, 60_000);
    this.timer.unref();
  }
  prune() { this.rows = this.rows.filter((r) => this.now() - r.at < 86400_000); }
  compact() { if (!this.enabled) return; this.prune(); this.journal.compact(this.rows); }
  async notify({ number, group, text, evo }) {
    if (!this.enabled || this.env[group ? 'GROUP_ALERT_ENABLED' : 'UNKNOWN_ALERT_ENABLED'] !== 'true') return;
    const to = registrable(numberOf(this.env.OPERATOR_CONTACT));
    if (!to) { this.log('alert_skipped', { code: 'no_operator_contact' }); return; }
    const n = registrable(numberOf(number));
    if (!group && !n) { this.log('alert_skipped', { code: 'number_unknown' }); return; }
    const identity = group ? `group:${group}` : `number:${[...variants(n)].sort()[0]}`;
    const key = createHash('sha256').update(identity).digest('hex');
    this.prune();
    if (this.rows.some((r) => r.key === key)) return;
    if (this.rows.filter((r) => this.now() - r.at < 3600_000).length >= this.limit) { this.log('alert_skipped', { code: 'hour_limit' }); return; }
    // Reserva durável ANTES do envio: evita tempestade após timeout/reinício.
    // Conta tentativa, inclusive falha; não reenvia cegamente aviso incerto.
    const record = { key, at: this.now() }; this.journal.append(record); this.rows.push(record);
    const message = group ? `Grupo sem registro tentou falar: ${group}.` : `Número sem acesso tentou falar: ${n}. Para liberar: peça ao agente 'libere ${n}'.${this.env.ALERT_INCLUDE_TEXT === 'true' && typeof text === 'string' ? `\nMensagem (conteúdo não confiável): ${text.slice(0, 500)}` : ''}`;
    try {
      const r = await evo.sendText({ number: to, text: message });
      this.log(r.kind === 'ok' ? 'alert_sent' : 'alert_failed', { code: r.kind === 'ok' ? 'ok' : 'send_failed' });
    } catch { this.log('alert_failed', { code: 'send_failed' }); }
  }
  close() { clearInterval(this.timer); this.journal?.close(); }
}
