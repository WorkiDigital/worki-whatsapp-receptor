// Encaminhamento ao executor (rotina Claude). DESLIGADO sem FORWARD_URL.
// FORWARD_TOKEN (Bearer) e FORWARD_EXTRA_HEADERS (JSON) ficam só nas variáveis do serviço.
// Contrato do acionamento (documentação das rotinas, 2026-10-07): POST .../routines/<id>/fire, corpo {"text": "..."}.
export function forwardConfig(env) {
  if (!env.FORWARD_URL) return null;
  const u = new URL(env.FORWARD_URL);
  if (u.protocol !== 'https:') throw new Error('FORWARD_URL precisa ser HTTPS');
  let extra = {};
  if (env.FORWARD_EXTRA_HEADERS) extra = JSON.parse(env.FORWARD_EXTRA_HEADERS);
  return { url: u.toString(), token: env.FORWARD_TOKEN, extra };
}

// Retorna o status HTTP; lança em erro de rede/timeout (resultado incerto: quem chama NÃO deve repetir o disparo).
export async function fire(cfg, text, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const res = await fetchImpl(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...cfg.extra },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.status;
}

// Modo Vercel (função sem fila): mantém o formato antigo, sem token de tarefa.
export async function forwardMessage(cfg, msg, { client, fetchImpl, timeoutMs } = {}) {
  const text = [`Nova mensagem WhatsApp (cliente: ${client})`, `de (número): ${msg.to || msg.senderId}`, `tipo: ${msg.type}`, `texto: ${msg.text ?? '(sem texto)'}`].join('\n');
  return fire(cfg, text, { fetchImpl, timeoutMs });
}
