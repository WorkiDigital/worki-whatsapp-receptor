import { isAllowed, numberOf } from './allow.js';
import { forwardMessage } from './forward.js';

// Decide o que fazer com cada mensagem pendente da fila: só números permitidos e recentes chegam à rotina.
// Não lançar = concluir (inclusive descartadas); lançar = nova tentativa. Logs sem conteúdo.
export function createDispatcher({ env, cfg, forward = forwardMessage, now = Date.now, log = () => {} }) {
  const maxAgeMs = Number(env.MAX_AGE_SECONDS || 600) * 1000;
  return async (ev) => {
    const p = ev.payload || {};
    const candidates = [ev.sender, p.senderAlt, ev.conv, p.convAlt];
    if (!isAllowed(env, ...candidates)) { log('skipped', { client: ev.client, code: 'not_allowed' }); return; }
    if (now() - (p.receivedAt ?? ev.at ?? now()) > maxAgeMs) { log('skipped', { client: ev.client, code: 'stale' }); return; }
    const to = candidates.map(numberOf).find(Boolean) || '';
    const s = await forward(cfg, { conversationId: ev.conv, senderId: ev.sender, to, type: p.type, text: p.text }, { client: ev.client, replyUrl: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/send` : undefined });
    if (s >= 400) throw Object.assign(new Error('destino recusou'), { code: 'forward_rejected' });
  };
}
