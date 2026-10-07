import { createHash, timingSafeEqual } from 'node:crypto';
const h = (s) => createHash('sha256').update(String(s)).digest();
export const validSecret = (expected, got) => Boolean(expected) && typeof got === 'string' && timingSafeEqual(h(expected), h(got));

// Rotação sem parada: aceita NOME e NOME_NEXT ao mesmo tempo (ex.: SEND_SECRET e SEND_SECRET_NEXT). Depois de trocar
// o outro lado, promova o NEXT para o nome principal e apague o NEXT. Compara sempre os dois (sem curto-circuito).
export const secretsOf = (env, name) => [env[name], env[`${name}_NEXT`]].filter(Boolean);
export function validAny(env, name, got) {
  let ok = false;
  for (const s of secretsOf(env, name)) if (validSecret(s, got)) ok = true;
  return ok;
}
