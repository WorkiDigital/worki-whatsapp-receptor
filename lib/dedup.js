// Deduplicação BEST-EFFORT em memória da instância da função (sem banco externo, por decisão).
// Limites: cada instância serverless tem a sua memória e ela some em cold start/redeploy; portanto
// reentregas podem passar. Para garantia, usar armazenamento (ex.: Upstash Redis do Marketplace da Vercel).
export function createDedup({ ttlMs = 10 * 60_000, max = 5000, now = Date.now } = {}) {
  const seen = new Map();
  return {
    // true = já visto (duplicada); false = nova (e registrada)
    check(key) {
      const t = now();
      for (const [k, at] of seen) { if (t - at > ttlMs) seen.delete(k); else break; }
      if (seen.has(key)) return true;
      seen.set(key, t);
      if (seen.size > max) seen.delete(seen.keys().next().value);
      return false;
    },
    size: () => seen.size,
  };
}
