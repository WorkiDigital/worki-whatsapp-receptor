import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';

// Fila durável local: diário append-only (JSONL) com fsync antes de confirmar.
// Entrega "pelo menos uma vez": evento pendente reaparece após reinício. Processo único (lock por pid).
// Diário contém conteúdo privado: diretório fora do Git (var/), modo 0700/0600.
//   {t:'e'} evento · {t:'d'} concluído · {t:'a'} tentativa falha (só código) · {t:'f'} falha definitiva
export class DurableQueue {
  constructor({ dir, maxAttempts = 3, backoffMs = 1000, now = Date.now } = {}) {
    if (!dir) throw new Error('dir obrigatório');
    this.dir = dir; this.maxAttempts = maxAttempts; this.backoffMs = backoffMs; this.now = now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#lock();
    this.events = new Map();   // key -> estado
    this.convs = new Map();    // "client\0conv" -> [keys em ordem de chegada]
    this.seq = 0; this.corruptLines = 0;
    this.journalPath = join(dir, 'journal.jsonl');
    this.#load();
    this.fd = openSync(this.journalPath, 'a', 0o600);
    this.#ensureNewline();
  }

  #lock() {
    this.lockPath = join(this.dir, 'queue.lock');
    if (existsSync(this.lockPath)) {
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = pid !== process.pid || this.constructor.held.has(this.lockPath); } catch { alive = false; }
      if (alive) throw new Error('fila já aberta por outro processo');
    }
    writeFileSync(this.lockPath, String(process.pid), { mode: 0o600 });
    this.constructor.held.add(this.lockPath);
  }

  #load() {
    if (!existsSync(this.journalPath)) return;
    for (const line of readFileSync(this.journalPath, 'utf8').split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { this.corruptLines++; continue; } // cauda truncada por queda
      if (r.t === 'e') this.#add(r);
      else {
        const ev = this.events.get(r.id);
        if (!ev) continue;
        if (r.t === 'd') { ev.status = 'done'; ev.payload = null; }
        else if (r.t === 'a') { ev.attempts = r.n; ev.lastCode = r.code; }
        else if (r.t === 'f') ev.status = 'failed';
      }
    }
  }

  #ensureNewline() {
    const size = fstatSync(this.fd).size;
    if (!size) return;
    const b = Buffer.alloc(1);
    const rfd = openSync(this.journalPath, 'r');
    try { readSync(rfd, b, 0, 1, size - 1); } finally { closeSync(rfd); }
    if (b[0] !== 0x0a) this.#append({ t: 'n' }, true);
  }

  #append(rec, raw = false) {
    writeSync(this.fd, raw ? '\n' : `${JSON.stringify(rec)}\n`);
    fsyncSync(this.fd);
  }

  #add(r) {
    const key = `${r.client}:${r.id}`;
    this.events.set(key, { key, seq: r.seq, client: r.client, conv: r.conv, sender: r.sender, at: r.at, payload: r.payload, attempts: 0, lastCode: null, status: 'pending', nextAt: 0 });
    const ck = `${r.client}\0${r.conv}`;
    if (!this.convs.has(ck)) this.convs.set(ck, []);
    this.convs.get(ck).push(key);
    this.seq = Math.max(this.seq, r.seq);
  }

  // Persiste (fsync) e só então retorna; duplicado por (cliente, eventId) não é regravado.
  enqueue({ client, conv, sender, eventId, payload }) {
    const key = `${client}:${eventId}`;
    if (this.events.has(key)) return { status: 'duplicate' };
    const rec = { t: 'e', seq: this.seq + 1, id: eventId, client, conv, sender, at: this.now(), payload };
    this.#append(rec);
    this.#add(rec);
    return { status: 'accepted', seq: rec.seq };
  }

  // Próximo evento pronto: cabeça de cada conversa (ordem de chegada) cujo backoff venceu; menor seq primeiro.
  // Cabeça com retentativa pendente bloqueia só a sua conversa.
  claim() {
    let best = null;
    for (const keys of this.convs.values()) {
      while (keys.length && this.events.get(keys[0]).status !== 'pending') keys.shift();
      const head = keys.length ? this.events.get(keys[0]) : null;
      if (head && head.nextAt <= this.now() && (!best || head.seq < best.seq)) best = head;
    }
    return best ? { key: best.key, seq: best.seq, client: best.client, conv: best.conv, sender: best.sender, payload: best.payload, attempts: best.attempts } : null;
  }

  complete(key) {
    const ev = this.events.get(key);
    this.#append({ t: 'd', id: key });
    ev.status = 'done'; ev.payload = null;
  }

  fail(key, code = 'handler_error') {
    const ev = this.events.get(key);
    ev.attempts += 1; ev.lastCode = code;
    this.#append({ t: 'a', id: key, n: ev.attempts, code, at: this.now() });
    if (ev.attempts >= this.maxAttempts) { this.#append({ t: 'f', id: key, at: this.now() }); ev.status = 'failed'; }
    else ev.nextAt = this.now() + this.backoffMs * 2 ** (ev.attempts - 1);
    return ev.status;
  }

  stats() {
    const s = { pending: 0, done: 0, failed: 0 };
    for (const e of this.events.values()) s[e.status]++;
    return s;
  }

  // Registro dos eventos que falharam definitivamente (sem conteúdo; o conteúdo permanece no diário local).
  listFailed() {
    return [...this.events.values()].filter((e) => e.status === 'failed').map((e) => ({ key: e.key, seq: e.seq, client: e.client, attempts: e.attempts, lastCode: e.lastCode }));
  }

  close() {
    try { closeSync(this.fd); } catch { /* já fechado */ }
    try { unlinkSync(this.lockPath); } catch { /* já removido */ }
    this.constructor.held.delete(this.lockPath);
  }
}
DurableQueue.held = new Set();
