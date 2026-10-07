#!/usr/bin/env node
// Modo VPS (EasyPanel/Docker): servidor Node com fila durável em disco, acessos e tarefas persistidos em DATA_DIR.
// Rota: POST /api/evolution/<cliente> (igual à da Vercel). GET /health para o healthcheck.
import http from 'node:http';
import { createHandler } from './lib/handler.js';
import { createStore, drain } from './lib/store.js';
import { forwardConfig } from './lib/forward.js';
import { createSendHandler } from './lib/send.js';
import { createDispatcher } from './lib/dispatch.js';
import { AccessStore } from './lib/access.js';
import { TaskStore } from './lib/tasks.js';
import { createEvo } from './lib/evo.js';
import { createApi } from './lib/api.js';
import { digits } from './lib/numbers.js';

const env = process.env;
const port = Number(env.PORT || 3000);
const dir = env.DATA_DIR || '/data';
// Tolerância do worker de disparo: o limite da rotina é 30 disparos/hora (documentação das rotinas); ajustar se necessário.
const store = createStore(dir, { maxAttempts: Number(env.QUEUE_MAX_ATTEMPTS || 3), backoffMs: Number(env.QUEUE_BACKOFF_MS || 1000) });
const handler = createHandler({ env, store });
// Administradores iniciais: ADMIN_SENDERS (ALLOWED_SENDERS como compatibilidade). Demais acessos: DATA_DIR/access.jsonl.
const admins = String(env.ADMIN_SENDERS || env.ALLOWED_SENDERS || '').split(',').map(digits).filter((d) => d.length >= 10);
const access = new AccessStore({ dir, admins });
const tasks = new TaskStore({ dir, ttlMs: Number(env.TASK_TTL_SECONDS || 7200) * 1000 });
const evo = createEvo({ env });
const api = createApi({ env, access, tasks, evo });
const sendHandler = createSendHandler({ env, access, evo });
const log = (event, f = {}) => console.log(JSON.stringify({ event, ...f }));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...store.queue.stats(), ...tasks.stats() })); }
  const m = /^\/api\/evolution\/([^/]+)$/.exec(url.pathname);
  const isSend = url.pathname === '/api/send';
  const isApi = /^\/api\/(task|ops|admin)\//.test(url.pathname);
  const shim = { status(c) { this.code = c; return this; }, json(o) { res.writeHead(this.code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); } };
  if (!m && !isSend && !isApi) return shim.status(404).json({ error: 'not_found' });
  const chunks = []; let size = 0; let aborted = false;
  req.on('data', (c) => { size += c.length; if (size > 262144) { aborted = true; shim.status(413).json({ error: 'too_large' }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (aborted) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { return shim.status(400).json({ error: 'malformed_json' }); }
    if (isApi) return api({ method: req.method, headers: req.headers, body }, shim, url.pathname).catch(() => shim.status(500).json({ error: 'internal_error' }));
    if (isSend) return sendHandler({ method: req.method, headers: req.headers, body }, shim);
    handler({ method: req.method, headers: req.headers, query: { client: decodeURIComponent(m[1]) }, body }, shim);
  });
});

// Worker: entrega pendentes ao destino (se FORWARD_URL existir). Sem destino, as mensagens ficam guardadas.
let cfg = null;
try { cfg = forwardConfig(env); } catch { log('error', { code: 'bad_forward_config' }); }
let busy = false;
const timer = setInterval(async () => {
  if (!cfg || busy) return;
  busy = true;
  try {
    await drain(store.queue, createDispatcher({ env, cfg, access, tasks, log }), log);
  } catch { log('error', { code: 'drain_failed' }); } finally { busy = false; }
}, 1000);

server.listen(port, env.HOST || '0.0.0.0', () => log('listening', { port, ...store.queue.stats(), destination: Boolean(cfg) }));
const stop = () => { clearInterval(timer); server.close(() => { store.close(); access.close(); tasks.close(); process.exit(0); }); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
