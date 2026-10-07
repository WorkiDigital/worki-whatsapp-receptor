#!/usr/bin/env node
// Modo VPS (EasyPanel/Docker): servidor Node com fila durável em disco. Não responde no WhatsApp.
// Rota: POST /api/evolution/<cliente> (igual à da Vercel). GET /health para o healthcheck.
import http from 'node:http';
import { createHandler } from './lib/handler.js';
import { createStore, drain } from './lib/store.js';
import { forwardConfig, forwardMessage } from './lib/forward.js';

const env = process.env;
const port = Number(env.PORT || 3000);
const dir = env.DATA_DIR || '/data';
const store = createStore(dir);
const handler = createHandler({ env, store });
const log = (event, f = {}) => console.log(JSON.stringify({ event, ...f }));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...store.queue.stats() })); }
  const m = /^\/api\/evolution\/([^/]+)$/.exec(url.pathname);
  const shim = { status(c) { this.code = c; return this; }, json(o) { res.writeHead(this.code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); } };
  if (!m) return shim.status(404).json({ error: 'not_found' });
  const chunks = []; let size = 0; let aborted = false;
  req.on('data', (c) => { size += c.length; if (size > 262144) { aborted = true; shim.status(413).json({ error: 'too_large' }); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (aborted) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { return shim.status(400).json({ error: 'malformed_json' }); }
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
    await drain(store.queue, async (ev) => {
      const s = await forwardMessage(cfg, { conversationId: ev.conv, senderId: ev.sender, type: ev.payload?.type, text: ev.payload?.text }, { client: ev.client });
      if (s >= 400) throw new Error('destino recusou');
    }, log);
  } catch { log('error', { code: 'drain_failed' }); } finally { busy = false; }
}, 1000);

server.listen(port, env.HOST || '0.0.0.0', () => log('listening', { port, ...store.queue.stats(), destination: Boolean(cfg) }));
const stop = () => { clearInterval(timer); server.close(() => { store.close(); process.exit(0); }); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
