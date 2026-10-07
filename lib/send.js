import { validSecret } from './security.js';
import { allowedList, digits, isAllowed } from './allow.js';

// Envio de resposta pelo WhatsApp (Evolution sendText). SÓ para números de ALLOWED_SENDERS, com segredo próprio
// (SEND_SECRET), interruptor (REPLY_ENABLED=true) e limites por minuto e por dia. Nunca envia a grupos.
// Logs sem texto nem número.
const log = (event, f = {}) => console.log(JSON.stringify({ event, ...f }));

export function createLimiter({ perMinute = 5, perDay = 50, now = Date.now } = {}) {
  const hits = [];
  return {
    take() {
      const t = now();
      while (hits.length && t - hits[0] > 86_400_000) hits.shift();
      if (hits.length >= perDay) return 'daily_limit';
      if (hits.filter((h) => t - h <= 60_000).length >= perMinute) return 'minute_limit';
      hits.push(t);
      return null;
    },
  };
}

export async function sendText({ env, number, text, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const base = String(env.EVOLUTION_API_URL || '').replace(/\/$/, '');
  if (!base || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) throw Object.assign(new Error('evolution não configurada'), { code: 'no_evolution' });
  const res = await fetchImpl(`${base}/message/sendText/${encodeURIComponent(env.EVOLUTION_INSTANCE)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number, text }), signal: AbortSignal.timeout(timeoutMs),
  });
  return res.status;
}

export function createSendHandler({ env = process.env, send = sendText, limiter = createLimiter({ perMinute: Number(env.REPLY_PER_MINUTE || 5), perDay: Number(env.REPLY_PER_DAY || 50) }) } = {}) {
  return async function handler(req, res) {
    const out = (c, o) => res.status(c).json(o);
    if (req.method !== 'POST') return out(405, { error: 'method_not_allowed' });
    if (env.REPLY_ENABLED !== 'true') { log('send_rejected', { code: 'replies_disabled' }); return out(503, { error: 'replies_disabled' }); }
    if (!env.SEND_SECRET) { log('send_rejected', { code: 'no_send_secret' }); return out(503, { error: 'not_configured' }); }
    if (!validSecret(env.SEND_SECRET, req.headers['x-send-secret'])) { log('send_rejected', { code: 'bad_secret' }); return out(401, { error: 'unauthorized' }); }
    const b = req.body;
    const to = digits(b?.to);
    if (!b || typeof b.to !== 'string' || /[@a-z]/i.test(b.to) || to.length < 10 || to.length > 15) return out(422, { error: 'invalid_to' });
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 1000) return out(422, { error: 'invalid_text' });
    if (!allowedList(env).length || !isAllowed(env, to)) { log('send_rejected', { code: 'number_not_allowed' }); return out(403, { error: 'number_not_allowed' }); }
    const lim = limiter.take();
    if (lim) { log('send_rejected', { code: lim }); return out(429, { error: lim }); }
    try {
      const s = await send({ env, number: to, text: b.text });
      if (s >= 400) { log('send_failed', { http: s }); return out(502, { error: 'evolution_error', http: s }); }
      log('sent', { http: s });
      return out(200, { status: 'sent' });
    } catch (e) { log('send_failed', { code: e?.code || 'error' }); return out(502, { error: 'send_failed' }); }
  };
}
