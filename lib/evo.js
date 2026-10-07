// Cliente mínimo da Evolution API 2.3.7 (contrato conferido no código oficial, tag 2.3.7). Auth: header `apikey`.
// Resultado de cada chamada: { kind: 'ok'|'rejected'|'uncertain', http?, data? }.
//   ok = HTTP 2xx; rejected = HTTP 4xx/5xx (o serviço respondeu que não fez); uncertain = timeout/rede (pode ter feito).
export function createEvo({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const need = () => {
    const base = String(env.EVOLUTION_API_URL || '').replace(/\/$/, '');
    if (!base || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) throw Object.assign(new Error('evolution não configurada'), { code: 'no_evolution' });
    return { base, inst: encodeURIComponent(env.EVOLUTION_INSTANCE) };
  };
  const call = async (method, path, body) => {
    const { base, inst } = need();
    let res;
    try {
      res = await fetchImpl(`${base}${path.replace('{i}', inst)}`, {
        method, headers: { 'Content-Type': 'application/json', apikey: env.EVOLUTION_API_KEY },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return { kind: 'uncertain' }; }
    let data = null;
    try { data = await res.json(); } catch { /* sem corpo */ }
    return { kind: res.status < 300 ? 'ok' : 'rejected', http: res.status, data };
  };
  return {
    sendText: ({ number, text, mentionsEveryOne, mentioned }) => call('POST', '/message/sendText/{i}', { number, text, ...(mentionsEveryOne ? { mentionsEveryOne: true } : {}), ...(mentioned?.length ? { mentioned } : {}) }),
    createGroup: ({ subject, participants, description }) => call('POST', '/group/create/{i}', { subject, participants, ...(description ? { description } : {}) }),
    sendPoll: ({ number, name, values, selectableCount }) => call('POST', '/message/sendPoll/{i}', { number, name, selectableCount, values }),
    sendReaction: ({ remoteJid, messageId, fromMe = false, reaction }) => call('POST', '/message/sendReaction/{i}', { key: { remoteJid, fromMe, id: messageId }, reaction }),
    findGroupInfos: (groupJid) => call('GET', `/group/findGroupInfos/{i}?groupJid=${encodeURIComponent(groupJid)}`),
    fetchAllGroups: () => call('GET', '/group/fetchAllGroups/{i}?getParticipants=true'),
  };
}
