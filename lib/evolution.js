// Adaptador do webhook da Evolution API 2.3.7 (campos conferidos no código oficial, tag 2.3.7).
// Corpo: { event: "messages.upsert" | "connection.update" | "qrcode.updated", instance, data, ... }.
// NÃO usar o campo `apikey` do corpo como credencial.
const norm = (e) => String(e || '').replace(/[.-]/g, '_').toUpperCase();
const textOf = (m = {}) => m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? m.videoMessage?.caption ?? undefined;

// kind: 'qr' | 'connection' (só estado) | 'ignore' | 'invalid' | 'message'
export function parseEvolutionEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'invalid', field: 'body' };
  const ev = norm(body.event);
  if (ev === 'QRCODE_UPDATED') return { kind: 'qr' };
  if (ev === 'CONNECTION_UPDATE') {
    const s = body.data?.state;
    return { kind: 'connection', state: typeof s === 'string' && /^[\w-]{1,32}$/.test(s) ? s : 'unknown' };
  }
  if (ev !== 'MESSAGES_UPSERT') return { kind: 'ignore', reason: 'event_not_enabled' };
  const d = body.data; const key = d?.key;
  if (!key || typeof key.id !== 'string' || typeof key.remoteJid !== 'string') return { kind: 'invalid', field: 'data.key' };
  if (key.fromMe === true) return { kind: 'ignore', reason: 'from_me' };
  if (key.remoteJid.endsWith('@broadcast')) return { kind: 'ignore', reason: 'broadcast' };
  const group = key.remoteJid.endsWith('@g.us');
  // Fixtures cover both layouts; a production 2.3.7 capture remains pending.
  const context = { ...d.contextInfo, ...(d.message?.extendedTextMessage?.contextInfo ?? d.message?.imageMessage?.contextInfo ?? d.message?.videoMessage?.contextInfo) };
  const ts = Number(d.messageTimestamp);
  return {
    kind: 'message',
    msgId: key.id,
    conversationId: key.remoteJid,
    senderId: group ? (key.participant || key.remoteJid) : key.remoteJid,
    type: typeof d.messageType === 'string' ? d.messageType.slice(0, 64) : 'unknown',
    text: textOf(d.message)?.slice(0, 4000),
    timestamp: Number.isFinite(ts) ? ts : undefined,
    senderAlt: key.participantAlt || key.senderPn || key.remoteJidAlt || undefined,
    convAlt: key.remoteJidAlt || key.senderPn || undefined,
    mentionedJid: Array.isArray(context.mentionedJid) ? context.mentionedJid.slice(0, 256) : [],
    mentionedJidAlt: Array.isArray(context.mentionedJidAlt) ? context.mentionedJidAlt.slice(0, 256) : [],
    participant: typeof context.participant === 'string' ? context.participant : undefined,
    participantAlt: context.participantAlt || context.participantPn || undefined,
    quotedMessage: Boolean(context.quotedMessage || context.stanzaId),
    instanceSender: typeof body.sender === 'string' ? body.sender : undefined,
  };
}
