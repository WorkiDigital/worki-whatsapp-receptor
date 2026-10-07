import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Journal } from './journal.js';
import { OPERATIONS, ADMIN_OPERATION } from './catalog.js';
import { digits, variants, registrable } from './numbers.js';

// Quem pode o quê. Fonte da verdade da autorização: o prompt NUNCA decide.
//  - Administradores iniciais: variável de ambiente (ADMIN_SENDERS; ALLOWED_SENDERS como compatibilidade). Valem para tudo.
//  - Demais pessoas: diário append-only em DATA_DIR/access.jsonl (quem concedeu, quem recebeu, escopo, validade, revogações).
//  - Permissão = pessoa ativa + concessão não revogada e não expirada que cubra (cliente, operação). Ausência = negado.
//  - Quem tem `manage_access` num cliente pode conceder, nesse cliente, só operações que ele próprio tem.
//    `manage_access` e escopo "*" só os administradores do ambiente concedem.
export class AccessError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const slug = /^[a-z0-9-]{1,64}$/;

export class AccessStore {
  constructor({ dir, admins = [], now = Date.now } = {}) {
    this.now = now;
    this.admins = new Set(admins.map(digits).filter(Boolean));
    this.people = new Map();   // número -> { number, name, status, grants[] }
    this.groups = new Map();   // jid -> { jid, client, name, status, addedBy, addedAt }
    this.journal = new Journal(join(dir, 'access.jsonl'));
    this.journal.open((r) => this.#apply(r));
  }

  #apply(r) {
    if (r.t === 'person') {
      const p = this.people.get(r.number) || { number: r.number, name: r.name, status: 'active', grants: [] };
      if (r.name) p.name = r.name;
      this.people.set(r.number, p);
    } else if (r.t === 'grant') {
      const p = this.people.get(r.number);
      if (p) p.grants.push({ id: r.id, clients: r.clients, ops: r.ops, expiresAt: r.expiresAt, grantedBy: r.by, grantedAt: r.at, note: r.note, revokedAt: null, revokedBy: null });
    } else if (r.t === 'revoke_grant') {
      const g = this.people.get(r.number)?.grants.find((x) => x.id === r.id);
      if (g && !g.revokedAt) { g.revokedAt = r.at; g.revokedBy = r.by; }
    } else if (r.t === 'status') {
      const p = this.people.get(r.number);
      if (p) { p.status = r.status; p.statusBy = r.by; p.statusAt = r.at; }
    } else if (r.t === 'group') {
      this.groups.set(r.jid, { jid: r.jid, client: r.client, name: r.name, status: r.status, addedBy: r.by, addedAt: r.at });
    }
  }

  #write(r) { const rec = { ...r, at: this.now() }; this.journal.append(rec); this.#apply(rec); return rec; }

  isAdmin(number) { return [...variants(number)].some((v) => this.admins.has(v)); }

  #find(number) { for (const v of variants(number)) { const p = this.people.get(v); if (p) return p; } return null; }

  #active(g) { return !g.revokedAt && (!g.expiresAt || Date.parse(g.expiresAt) > this.now()); }

  #covers(g, client) { return g.clients.includes('*') || (client != null && g.clients.includes(client)); }

  // Pode falar com o assistente? (administrador, ou pessoa ativa com alguma concessão válida)
  hasAccess(number) {
    if (this.isAdmin(number)) return true;
    const p = this.#find(number);
    return Boolean(p && p.status === 'active' && p.grants.some((g) => this.#active(g)));
  }

  // Clientes visíveis para a pessoa: '*' ou lista.
  clientsFor(number) {
    if (this.isAdmin(number)) return '*';
    const p = this.#find(number);
    if (!p || p.status !== 'active') return [];
    const set = new Set();
    for (const g of p.grants) if (this.#active(g)) for (const c of g.clients) set.add(c);
    return set.has('*') ? '*' : [...set];
  }

  can(number, op, client) {
    if (this.isAdmin(number)) return { ok: true, via: 'admin' };
    const p = this.#find(number);
    if (!p) return { ok: false, reason: 'unknown_person' };
    if (p.status !== 'active') return { ok: false, reason: p.status };
    const g = p.grants.find((x) => this.#active(x) && x.ops.includes(op) && this.#covers(x, client));
    return g ? { ok: true, via: g.id } : { ok: false, reason: 'no_grant' };
  }

  view(number) {
    const admin = this.isAdmin(number);
    const p = this.#find(number);
    if (!p && !admin) return null;
    return {
      number: p?.number ?? digits(number), name: p?.name ?? null, admin, status: p?.status ?? 'active',
      grants: (p?.grants ?? []).map((g) => ({ id: g.id, clients: g.clients, ops: g.ops, expiresAt: g.expiresAt, active: this.#active(g), grantedBy: g.grantedBy, grantedAt: g.grantedAt, revokedAt: g.revokedAt, revokedBy: g.revokedBy })),
    };
  }

  list() { return [...this.people.values()].map((p) => this.view(p.number)); }

  // Valida e confere se `by` pode conceder. Lança AccessError.
  #authorizeGrant(by, clients, ops) {
    if (this.isAdmin(by)) return;
    if (clients.includes('*')) throw new AccessError('forbidden', 'escopo "*" só administrador do ambiente');
    if (ops.includes(ADMIN_OPERATION)) throw new AccessError('forbidden', 'manage_access só administrador do ambiente');
    for (const c of clients) {
      if (!this.can(by, ADMIN_OPERATION, c).ok) throw new AccessError('forbidden', `sem manage_access no cliente ${c}`);
      for (const op of ops) if (!this.can(by, op, c).ok) throw new AccessError('forbidden', `quem concede precisa ter ${op} em ${c}`);
    }
  }

  #normalize({ number, clients, ops, expiresAt }) {
    const n = registrable(number);
    if (!n) throw new AccessError('invalid_number', 'número inválido: informe com DDI (ex.: 5585…)');
    if (!Array.isArray(clients) || !clients.length || clients.some((c) => c !== '*' && !slug.test(c))) throw new AccessError('invalid_clients', 'clients: lista de slugs (ou "*")');
    if (!Array.isArray(ops) || !ops.length) throw new AccessError('invalid_ops', 'ops: lista não vazia');
    const known = [...OPERATIONS, ADMIN_OPERATION];
    const bad = ops.filter((o) => !known.includes(o));
    if (bad.length) throw new AccessError('invalid_ops', `operações desconhecidas: ${bad.join(', ')}`);
    let exp = null;
    if (expiresAt != null) {
      if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now()) throw new AccessError('invalid_expiry', 'expiresAt deve ser uma data futura');
      exp = new Date(expiresAt).toISOString();
    }
    return { n, clients: [...new Set(clients)], ops: [...new Set(ops)], exp };
  }

  // mode 'add' acrescenta uma concessão; 'set' revoga as ativas da pessoa antes de registrar a nova.
  grant({ by, number, name, clients, ops, expiresAt = null, note = null, mode = 'add' }) {
    const { n, clients: cl, ops: os, exp } = this.#normalize({ number, clients, ops, expiresAt });
    this.#authorizeGrant(by, cl, os);
    if (this.isAdmin(n) && !this.isAdmin(by)) throw new AccessError('forbidden', 'não é possível alterar administrador');
    const existing = this.#find(n);
    const key = existing?.number ?? n;
    // Revogado só volta por concessão explícita de administrador do ambiente (quem tem escopo de cliente não desfaz).
    if (existing?.status === 'revoked') {
      if (!this.isAdmin(by)) throw new AccessError('forbidden', 'acesso revogado: só administrador do ambiente concede de novo');
      this.#write({ t: 'status', number: key, status: 'active', by });
    }
    if (!existing) this.#write({ t: 'person', number: key, name: name || null, by });
    else if (name && name !== existing.name) this.#write({ t: 'person', number: key, name, by });
    if (mode === 'set') for (const g of this.people.get(key).grants) if (this.#active(g)) this.#write({ t: 'revoke_grant', number: key, id: g.id, by });
    const id = `g_${randomBytes(4).toString('hex')}`;
    this.#write({ t: 'grant', id, number: key, clients: cl, ops: os, expiresAt: exp, note, by });
    return this.view(key);
  }

  #target(by, number) {
    const p = this.#find(registrable(number) ?? '');
    if (!p) throw new AccessError('unknown_person', 'pessoa não cadastrada');
    if (!this.isAdmin(by)) {
      const clients = new Set(p.grants.filter((g) => this.#active(g)).flatMap((g) => g.clients));
      if (!clients.size || clients.has('*') || [...clients].some((c) => !this.can(by, ADMIN_OPERATION, c).ok)) throw new AccessError('forbidden', 'fora do seu escopo de administração');
    }
    return p;
  }

  setStatus({ by, number, status }) {
    if (!['active', 'suspended', 'revoked'].includes(status)) throw new AccessError('invalid_status');
    if (this.isAdmin(number) && !this.isAdmin(by)) throw new AccessError('forbidden', 'não é possível alterar administrador');
    const p = this.#target(by, number);
    if (p.status === 'revoked' && status !== 'revoked') throw new AccessError('revoked', 'acesso revogado: o administrador do ambiente precisa conceder de novo (grant)');
    this.#write({ t: 'status', number: p.number, status, by });
    if (status === 'revoked') for (const g of p.grants) if (this.#active(g)) this.#write({ t: 'revoke_grant', number: p.number, id: g.id, by });
    return this.view(p.number);
  }

  revokeGrant({ by, number, grantId }) {
    const p = this.#target(by, number);
    const g = p.grants.find((x) => x.id === grantId);
    if (!g) throw new AccessError('unknown_grant');
    if (!g.revokedAt) this.#write({ t: 'revoke_grant', number: p.number, id: grantId, by });
    return this.view(p.number);
  }

  // Grupos atendidos: o grupo precisa estar registrado para um cliente. Participar do grupo não dá acesso a ninguém.
  group(jid) { const g = this.groups.get(String(jid)); return g && g.status === 'active' ? g : null; }

  registerGroup({ by, jid, client, name = null }) {
    if (!/^\d{10,}(-\d+)?@g\.us$/.test(String(jid))) throw new AccessError('invalid_group', 'jid de grupo inválido');
    if (!slug.test(String(client))) throw new AccessError('invalid_clients');
    if (!this.isAdmin(by) && !this.can(by, ADMIN_OPERATION, client).ok) throw new AccessError('forbidden', `sem manage_access no cliente ${client}`);
    this.#write({ t: 'group', jid, client, name, status: 'active', by });
    return this.groups.get(jid);
  }

  removeGroup({ by, jid }) {
    const g = this.groups.get(String(jid));
    if (!g) throw new AccessError('unknown_group');
    if (!this.isAdmin(by) && !this.can(by, ADMIN_OPERATION, g.client).ok) throw new AccessError('forbidden');
    this.#write({ t: 'group', jid: g.jid, client: g.client, name: g.name, status: 'removed', by });
    return this.groups.get(g.jid);
  }

  listGroups() { return [...this.groups.values()].filter((g) => g.status === 'active'); }

  close() { this.journal.close(); }
}
