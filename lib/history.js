import { join } from 'node:path';
import { Journal } from './journal.js';

export const positive = (v, fallback) => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : fallback;

// Dados privados, nunca logs. Instância única por DATA_DIR, como os demais diários.
export class History {
  constructor({ dir, env = {}, now = Date.now }) {
    this.enabled = env.HISTORY_ENABLED === 'true';
    this.now = now;
    this.limit = positive(env.HISTORY_MESSAGES, 10);
    this.age = positive(env.HISTORY_MAX_AGE_HOURS, 24) * 3600_000;
    this.rows = [];
    if (!this.enabled) return;
    this.journal = new Journal(join(dir, 'history.jsonl'));
    this.journal.open((r) => {
      if (typeof r.conv === 'string' && typeof r.text === 'string' && ['user', 'assistant'].includes(r.role) && Number.isFinite(r.at)) this.rows.push({ ...r, text: r.text.slice(0, 500) });
    });
    this.compact();
    this.timer = setInterval(() => this.safeCompact(), 60_000);
    this.timer.unref();
  }
  prune() {
    const cutoff = this.now() - this.age;
    const counts = new Map();
    this.rows = this.rows.filter((r) => r.at >= cutoff && r.at <= this.now()).reverse().filter((r) => {
      const n = counts.get(r.conv) || 0; counts.set(r.conv, n + 1); return n < this.limit;
    }).reverse();
  }
  recent(conv, excludeId) { if (!this.enabled) return []; this.prune(); return this.rows.filter((r) => r.conv === conv && (!excludeId || r.id !== excludeId)).map((r) => ({ role: r.role, text: r.text })); }
  add({ conv, role, text, id }) {
    if (!this.enabled || typeof conv !== 'string' || typeof text !== 'string' || !['user', 'assistant'].includes(role)) return;
    this.prune();
    if (id && this.rows.some((r) => r.conv === conv && r.id === id)) return;
    const r = { conv, role, text: text.slice(0, 500), at: this.now(), ...(id ? { id } : {}) };
    this.journal.append(r); this.rows.push(r); this.prune();
    this.writes = (this.writes || 0) + 1;
    if (this.writes >= 100) this.compact();
  }
  compact() { if (!this.enabled) return; this.prune(); this.journal.compact(this.rows); this.writes = 0; }
  safeCompact() { try { this.compact(); } catch { /* próxima manutenção tenta novamente; nenhum dado no log */ } }
  close() { clearInterval(this.timer); this.journal?.close(); }
}

// Falha da memória não pode converter um envio confirmado em erro/reenvio.
export function remember(history, record) { try { history?.add(record); } catch { /* histórico indisponível */ } }
