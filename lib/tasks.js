import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Journal } from './journal.js';

// Ciclo de vida de cada pedido (separado da fila de mensagens, que só garante entrega à rotina):
//   persisted -> dispatched -> started -> external_done -> verified -> replied
//   desvios: dispatch_failed, dispatch_uncertain (disparo sem resposta: NÃO repete), failed, uncertain, revoked,
//   handoff (humano avisado de fato: ver /api/ops/handoff)
// "Rotina acionada" é só `dispatched`; sucesso exige `verified` com evidência e `replied`.
// O token da tarefa liga o remetente VERIFICADO (webhook) ao que a rotina faz: o modelo não declara identidade.
export const STATES = ['persisted', 'dispatched', 'dispatch_failed', 'dispatch_uncertain', 'started', 'external_done', 'verified', 'replied', 'failed', 'uncertain', 'revoked', 'handoff'];
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export class TaskStore {
  constructor({ dir, now = Date.now, ttlMs = 2 * 3600_000 } = {}) {
    this.now = now; this.ttlMs = ttlMs;
    this.tasks = new Map();     // id -> tarefa
    this.byToken = new Map();   // sha(token) -> id
    this.byEvent = new Map();   // chave do evento -> id
    this.ops = new Map();       // `${taskId}|${key}` -> operação
    this.journal = new Journal(join(dir, 'tasks.jsonl'));
    this.journal.open((r) => this.#apply(r));
  }

  #apply(r) {
    if (r.t === 'task') {
      const task = { id: r.id, eventKey: r.eventKey, sender: r.sender, conv: r.conv, isGroup: r.isGroup, client: r.client, msgId: r.msgId, request: r.request, at: r.at, expiresAt: r.expiresAt, tokenHash: r.tokenHash, state: 'persisted', history: [{ state: 'persisted', at: r.at }], replies: 0 };
      this.tasks.set(r.id, task); this.byToken.set(r.tokenHash, r.id); this.byEvent.set(r.eventKey, r.id);
    } else if (r.t === 'rotate') {
      const task = this.tasks.get(r.id);
      if (task) { this.byToken.delete(task.tokenHash); task.tokenHash = r.tokenHash; task.expiresAt = r.expiresAt; this.byToken.set(r.tokenHash, r.id); }
    } else if (r.t === 'state') {
      const task = this.tasks.get(r.id);
      if (task) { task.state = r.state; task.history.push({ state: r.state, at: r.at, note: r.note }); if (r.state === 'replied') task.replies++; }
    } else if (r.t === 'op') {
      this.ops.set(`${r.id}|${r.key}`, { taskId: r.id, key: r.key, op: r.op, status: r.status, evidence: r.evidence, platform: r.platform, ref: r.ref, at: r.at, history: [] });
    }
  }

  #write(r) { const rec = { ...r, at: this.now() }; this.journal.append(rec); this.#apply(rec); return rec; }

  // Cria a tarefa de um evento persistido. Se já existir e o disparo ainda não ocorreu, reemite o token (retentativa);
  // se já foi disparado (ou ficou incerto), devolve null: não dispara de novo.
  issue({ eventKey, sender, conv, isGroup, client, msgId, request }) {
    const existing = this.byEvent.get(eventKey);
    const token = randomBytes(24).toString('hex');
    if (existing) {
      const t = this.tasks.get(existing);
      if (t.state !== 'persisted' && t.state !== 'dispatch_failed') return null;
      this.#write({ t: 'rotate', id: existing, tokenHash: sha(token), expiresAt: this.now() + this.ttlMs });
      return { task: this.tasks.get(existing), token };
    }
    const id = `t_${this.now().toString(36)}${randomBytes(3).toString('hex')}`;
    this.#write({ t: 'task', id, eventKey, sender, conv, isGroup: Boolean(isGroup), client: client ?? null, msgId: msgId ?? null, request: String(request ?? '').slice(0, 500), tokenHash: sha(token), expiresAt: this.now() + this.ttlMs });
    return { task: this.tasks.get(id), token };
  }

  authenticate(token) {
    if (typeof token !== 'string' || !token) return null;
    const id = this.byToken.get(sha(token));
    const t = id && this.tasks.get(id);
    if (!t || t.expiresAt < this.now()) return null;
    return t;
  }

  setState(id, state, note) {
    if (!STATES.includes(state)) throw new Error(`estado inválido: ${state}`);
    this.#write({ t: 'state', id, state, note: note ? String(note).slice(0, 200) : undefined });
    return this.tasks.get(id);
  }

  // Operação externa idempotente por (tarefa, chave). status: started | done | verified | failed | uncertain.
  getOp(taskId, key) { return this.ops.get(`${taskId}|${key}`) ?? null; }
  recordOp({ taskId, key, op, status, evidence, platform, ref }) {
    this.#write({ t: 'op', id: taskId, key, op, status, evidence: evidence ? String(evidence).slice(0, 1000) : undefined, platform, ref: ref ? String(ref).slice(0, 300) : undefined });
    return this.getOp(taskId, key);
  }
  opsOf(taskId) { return [...this.ops.values()].filter((o) => o.taskId === taskId); }

  view(t) {
    return { id: t.id, state: t.state, client: t.client, isGroup: t.isGroup, at: t.at, request: t.request, replies: t.replies, ops: this.opsOf(t.id).map((o) => ({ op: o.op, status: o.status, platform: o.platform, ref: o.ref, evidence: o.evidence })) };
  }

  // Histórico para perguntas sobre pedidos anteriores. `sender` limita ao próprio remetente (admin passa undefined).
  history({ sender, client, limit = 10 } = {}) {
    return [...this.tasks.values()]
      .filter((t) => (!sender || t.sender === sender) && (!client || t.client === client))
      .sort((a, b) => b.at - a.at).slice(0, Math.min(Number(limit) || 10, 50)).map((t) => this.view(t));
  }

  stats(stalledMs = 30 * 60_000) {
    const s = {};
    for (const t of this.tasks.values()) s[t.state] = (s[t.state] || 0) + 1;
    const stalled = [...this.tasks.values()].filter((t) => ['dispatched', 'started', 'external_done', 'verified', 'handoff'].includes(t.state) && this.now() - t.at > stalledMs).length;
    return { tasks: s, stalled };
  }

  close() { this.journal.close(); }
}
