import { validAny, secretsOf } from './security.js';
import { digits } from './numbers.js';
import { createLimiter } from './api.js';
import { remember } from './history.js';

// COMPATIBILIDADE (obsoleto): `/api/send` sem token de tarefa, usado pelo prompt antigo da rotina.
// Só envia a quem TEM ACESSO no armazenamento de acessos (nunca a grupos), com segredo próprio, interruptor e limites.
// O fluxo novo é `/api/task/reply` (destino derivado da tarefa verificada). Remover quando a rotina migrar.
const log = (event, f = {}) => console.log(JSON.stringify({ event, ...f }));

export function createSendHandler({ env = process.env, access, evo, history, limiter = createLimiter({ perMinute: Number(env.REPLY_PER_MINUTE || 5), perDay: Number(env.REPLY_PER_DAY || 50) }) } = {}) {
  return async function handler(req, res) {
    const out = (c, o) => res.status(c).json(o);
    if (req.method !== 'POST') return out(405, { error: 'method_not_allowed' });
    if (env.REPLY_ENABLED !== 'true') { log('send_rejected', { code: 'replies_disabled' }); return out(503, { error: 'replies_disabled' }); }
    if (!secretsOf(env, 'SEND_SECRET').length) { log('send_rejected', { code: 'no_send_secret' }); return out(503, { error: 'not_configured' }); }
    if (!validAny(env, 'SEND_SECRET', req.headers['x-send-secret'])) { log('send_rejected', { code: 'bad_secret' }); return out(401, { error: 'unauthorized' }); }
    const b = req.body;
    const to = digits(b?.to);
    if (!b || typeof b.to !== 'string' || /[@a-z]/i.test(b.to) || to.length < 10 || to.length > 15) return out(422, { error: 'invalid_to' });
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 1000) return out(422, { error: 'invalid_text' });
    if (!access.hasAccess(to)) { log('send_rejected', { code: 'number_not_allowed' }); return out(403, { error: 'number_not_allowed' }); }
    const lim = limiter.take();
    if (lim) { log('send_rejected', { code: lim }); return out(429, { error: lim }); }
    const r = await evo.sendText({ number: to, text: b.text });
    if (r.kind === 'ok') { if (env.HISTORY_ENABLED === 'true') remember(history, { conv: `${to}@s.whatsapp.net`, role: 'assistant', text: b.text }); log('sent', { http: r.http }); return out(200, { status: 'sent' }); }
    log('send_failed', { http: r.http, code: r.kind });
    return out(502, { error: r.kind === 'uncertain' ? 'send_failed' : 'evolution_error', http: r.http });
  };
}
