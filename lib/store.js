import { DurableQueue } from './queue.js';

// Adapta a fila durável (diário em disco com fsync, dedup por cliente+id da mensagem, sobrevive a reinício).
export function createStore(dir, opts = {}) {
  const queue = new DurableQueue({ dir, ...opts });
  return {
    queue,
    enqueue: ({ client, msg }) => queue.enqueue({ client, conv: msg.conversationId, sender: msg.senderId, eventId: msg.msgId, payload: { type: msg.type, text: msg.text, timestamp: msg.timestamp } }).status,
    close: () => queue.close(),
  };
}

// Entrega ao destino o que está pendente (até maxAttempts, com backoff da fila). Retorna quantos processou.
// `send(ev)` recebe { client, conv, sender, payload } e deve lançar em caso de falha.
export async function drain(queue, send, log = () => {}) {
  let n = 0;
  for (let ev = queue.claim(); ev; ev = queue.claim()) {
    try { await send(ev); queue.complete(ev.key); log('delivered', { client: ev.client, seq: ev.seq }); }
    catch { const st = queue.fail(ev.key, 'forward_failed'); log(st === 'failed' ? 'delivery_failed' : 'delivery_retry', { client: ev.client, seq: ev.seq, attempts: ev.attempts + 1 }); }
    n++;
  }
  return n;
}
