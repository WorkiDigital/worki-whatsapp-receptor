// Normalização de números. Só dígitos; o JID individual (…@s.whatsapp.net) vale, grupo (@g.us) e @lid nunca viram número.
export const digits = (s) => String(s ?? '').replace(/\D/g, '');

// O WhatsApp pode entregar um celular brasileiro com ou sem o "9" depois do DDD. Única equivalência aceita.
export function variants(n) {
  const d = digits(n);
  const out = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) out.add(`${d.slice(0, 4)}9${d.slice(4)}`);
  return out;
}

export function numberOf(x) {
  const s = String(x ?? '');
  if (!s.includes('@')) return digits(s);
  return s.endsWith('@s.whatsapp.net') ? digits(s.split('@')[0]) : '';
}

// Número para cadastro: exige DDI (recusa 10 ou 11 dígitos sem DDI, que seriam ambíguos) e 10 a 15 dígitos.
export function registrable(n) {
  const d = digits(n);
  if (d.length < 10 || d.length > 15) return null;
  if (d.length === 10 || (d.length === 11 && !d.startsWith('1'))) return null;
  return d;
}
