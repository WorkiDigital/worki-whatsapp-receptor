import { parseEvolutionEvent } from './evolution.js';
import { validAny, secretsOf } from './security.js';
import { createDedup } from './dedup.js';
import { forwardConfig, forwardMessage } from './forward.js';

// Logs só com campos permitidos: nunca texto, remetente, conversa, segredo ou QR.
const log = (event, f = {}) => console.log(JSON.stringify({ event, ...f }));

// `store` (opcional, modo VPS): fila durável com enqueue({client, ...msg}) -> 'accepted' | 'duplicate'; o envio ao destino
// é feito por um worker, não aqui. Sem `store` (modo Vercel): dedup em memória e encaminhamento em segundo plano.
export function createHandler({ env = process.env, dedup = createDedup(), forward = forwardMessage, waitUntil = (p) => p.catch(() => {}), store = null } = {}) {
  return async function handler(req, res) {
    const send = (code, obj) => res.status(code).json(obj);
    if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
    if (!secretsOf(env, 'EVOLUTION_WEBHOOK_SECRET').length) { log('rejected', { code: 'no_secret_configured' }); return send(503, { error: 'not_configured' }); }
    if (!validAny(env, 'EVOLUTION_WEBHOOK_SECRET', req.headers['x-webhook-secret'])) { log('rejected', { code: 'bad_secret' }); return send(401, { error: 'unauthorized' }); }

    const client = String(req.query?.client ?? '');
    const allowed = (env.ALLOWED_CLIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!/^[a-z0-9-]{1,64}$/.test(client) || !allowed.includes(client)) { log('rejected', { code: 'unknown_client' }); return send(404, { error: 'unknown_client' }); }

    const p = parseEvolutionEvent(req.body);
    if (p.kind === 'invalid') { log('rejected', { code: 'invalid_event', client }); return send(422, { error: 'invalid_event', field: p.field }); }
    // QR e conexão: só estado. Nunca acionam IA nem encaminham nada.
    if (p.kind === 'qr') { log('qr_updated', { client }); return send(200, { status: 'state_only' }); }
    if (p.kind === 'connection') { log('connection_update', { client, state: p.state }); return send(200, { status: 'state_only' }); }
    if (p.kind === 'ignore') { log('ignored', { client, code: p.reason }); return send(200, { status: 'ignored' }); }

    if (store) {
      let r;
      try { r = store.enqueue({ client, msg: p }); } catch { log('error', { code: 'persist_failed', client }); return send(500, { error: 'persist_failed' }); }
      log(r, { client });
      return send(r === 'accepted' ? 202 : 200, { status: r });
    }
    if (dedup.check(`${client}:${p.msgId}`)) { log('duplicate', { client }); return send(200, { status: 'duplicate' }); }

    let cfg;
    try { cfg = forwardConfig(env); } catch { log('error', { code: 'bad_forward_config' }); return send(500, { error: 'bad_forward_config' }); }
    if (!cfg) { log('accepted_no_destination', { client }); return send(202, { status: 'accepted_no_destination' }); }
    waitUntil(forward(cfg, p, { client }).then((s) => log('forwarded', { client, http: s })).catch(() => log('forward_failed', { client })));
    log('accepted', { client });
    return send(202, { status: 'accepted' });
  };
}
