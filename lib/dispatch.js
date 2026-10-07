import { numberOf } from './numbers.js';
import { fire } from './forward.js';
import { buildFireText } from './prompt.js';
import { remember } from './history.js';

// Decide o que fazer com cada mensagem pendente: só quem tem acesso (e, em grupo, só grupo registrado) chega à rotina.
// Não lançar = concluir o evento da fila (inclusive descartados); lançar = nova tentativa (só quando o disparo foi RECUSADO).
// Disparo sem resposta (timeout/rede) é incerto: a rotina pode ter iniciado, então não repete (estado dispatch_uncertain).
// Logs sem conteúdo.
export function createDispatcher({ env, cfg, access, tasks, history, fireImpl = fire, now = Date.now, log = () => {} }) {
  const maxAgeMs = Number(env.MAX_AGE_SECONDS || 600) * 1000;
  const baseUrl = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  return async (ev) => {
    const p = ev.payload || {};
    const isGroup = ev.conv.endsWith('@g.us');
    // Remetente individual verificado: grupo -> participante; privado -> JID da conversa (ou alternativo com número).
    const sender = [ev.sender, p.senderAlt, ...(isGroup ? [] : [ev.conv, p.convAlt])].map(numberOf).find(Boolean) || '';
    if (isGroup && !access.group(ev.conv)) { log('skipped', { client: ev.client, code: 'group_not_registered' }); return; }
    if (!sender || !access.hasAccess(sender)) { log('skipped', { client: ev.client, code: 'not_allowed' }); return; }
    if (now() - (p.receivedAt ?? ev.at ?? now()) > maxAgeMs) { log('skipped', { client: ev.client, code: 'stale' }); return; }
    if (!baseUrl) { log('skipped', { client: ev.client, code: 'no_public_base_url' }); return; }

    const issued = tasks.issue({ eventKey: ev.key, sender, conv: ev.conv, isGroup, client: isGroup ? access.group(ev.conv).client : null, msgId: ev.key.split(':').slice(1).join(':'), request: p.text });
    if (!issued) { log('skipped', { client: ev.client, code: 'already_dispatched' }); return; }
    const recent = env.HISTORY_ENABLED === 'true' ? history?.recent(ev.conv, ev.key) : [];
    if (env.HISTORY_ENABLED === 'true') remember(history, { conv: ev.conv, role: 'user', text: p.text, id: ev.key });
    const text = buildFireText({ task: issued.task, token: issued.token, text: p.text, type: p.type, access, baseUrl, history: recent });
    let status;
    try { status = await fireImpl(cfg, text); } catch {
      tasks.setState(issued.task.id, 'dispatch_uncertain', 'sem_resposta');
      log('dispatch_uncertain', { client: ev.client, task: issued.task.id });
      return;
    }
    if (status >= 400) { tasks.setState(issued.task.id, 'dispatch_failed', `http_${status}`); throw Object.assign(new Error('destino recusou'), { code: 'forward_rejected' }); }
    // A rotina pode já ter avançado a tarefa antes de o disparo retornar: não retroceder o estado.
    if (tasks.tasks.get(issued.task.id).state === 'persisted' || tasks.tasks.get(issued.task.id).state === 'dispatch_failed') tasks.setState(issued.task.id, 'dispatched');
    log('dispatched', { client: ev.client, task: issued.task.id });
  };
}
