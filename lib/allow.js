// Números permitidos (ALLOWED_SENDERS, separados por vírgula, só dígitos com DDI). Compara com e sem o "9" do celular
// brasileiro, porque o WhatsApp pode entregar o JID de qualquer das duas formas.
export const digits = (s) => String(s ?? '').replace(/\D/g, '');

export function variants(n) {
  const d = digits(n);
  const out = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) out.add(`${d.slice(0, 4)}9${d.slice(4)}`);
  return out;
}

export const allowedList = (env) => String(env.ALLOWED_SENDERS || '').split(',').map(digits).filter((d) => d.length >= 10 && d.length <= 15);

// Aceita número puro ou JID individual (…@s.whatsapp.net). Grupos (@g.us) e @lid nunca casam por si só.
export function numberOf(x) {
  const s = String(x ?? '');
  if (!s.includes('@')) return digits(s);
  return s.endsWith('@s.whatsapp.net') ? digits(s.split('@')[0]) : '';
}

export function isAllowed(env, ...candidates) {
  const allow = allowedList(env).flatMap((n) => [...variants(n)]);
  if (!allow.length) return false;
  return candidates.some((c) => { const n = numberOf(c); return n && [...variants(n)].some((v) => allow.includes(v)); });
}
