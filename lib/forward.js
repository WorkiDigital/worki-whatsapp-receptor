// Encaminhamento opcional da mensagem real para um destino (ex.: rotina Claude). DESLIGADO sem FORWARD_URL.
// FORWARD_TOKEN (Bearer) e FORWARD_EXTRA_HEADERS (JSON) ficam só nas variáveis do projeto Vercel.
// O formato aceito pelo destino NÃO foi validado: confirmar na documentação do destino antes de ligar.
export function forwardConfig(env) {
  if (!env.FORWARD_URL) return null;
  const u = new URL(env.FORWARD_URL);
  if (u.protocol !== 'https:') throw new Error('FORWARD_URL precisa ser HTTPS');
  let extra = {};
  if (env.FORWARD_EXTRA_HEADERS) extra = JSON.parse(env.FORWARD_EXTRA_HEADERS);
  return { url: u.toString(), token: env.FORWARD_TOKEN, extra };
}

export async function forwardMessage(cfg, msg, { client, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const text = `Nova mensagem WhatsApp (cliente: ${client})\nconversa: ${msg.conversationId}\nde: ${msg.senderId}\ntipo: ${msg.type}\ntexto: ${msg.text ?? '(sem texto)'}`;
  const res = await fetchImpl(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...cfg.extra },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.status;
}
