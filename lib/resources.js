import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Vínculos de cliente são dados administrativos do volume, nunca do pedido recebido.
// O arquivo pode conter IDs de contas/projetos, mas nunca credenciais.
const slug = /^[a-z0-9-]{1,64}$/;
const text = (v, max = 160) => typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

export function validateResources(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.clients || typeof value.clients !== 'object') {
    throw new Error('resources inválido: esperado {clients:{...}}');
  }
  const clients = {};
  for (const [client, raw] of Object.entries(value.clients)) {
    if (!slug.test(client) || !raw || typeof raw !== 'object') throw new Error('resources: cliente inválido');
    const out = {};
    if (raw.github !== undefined) {
      const repo = text(raw.github.repo, 200);
      if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('resources: github.repo inválido');
      out.github = { repo, baseBranch: text(raw.github.baseBranch, 100) || 'main', pathPrefix: text(raw.github.pathPrefix, 100) || 'pages' };
    }
    if (raw.vercel !== undefined) {
      const projectId = text(raw.vercel.projectId, 200);
      const name = text(raw.vercel.name, 100);
      if (!projectId || !name) throw new Error('resources: vercel exige projectId e name');
      out.vercel = { projectId, name, teamId: text(raw.vercel.teamId, 200) || null, allowedHosts: Array.isArray(raw.vercel.allowedHosts) ? raw.vercel.allowedHosts.filter((h) => typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h)).slice(0, 10) : [] };
    }
    if (raw.zernio !== undefined) {
      const accountId = text(raw.zernio.accountId, 100);
      if (!accountId) throw new Error('resources: zernio.accountId inválido');
      out.zernio = { accountId, platform: raw.zernio.platform === 'facebook' ? 'facebook' : 'instagram' };
    }
    clients[client] = out;
  }
  return { version: 1, clients };
}

export function loadResources(dir) {
  const path = join(dir, 'resources.json');
  if (!existsSync(path)) return { version: 1, clients: {} };
  try { return validateResources(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (e) { throw Object.assign(new Error('resources_invalid'), { code: 'resources_invalid', cause: e }); }
}

export const resourcePath = (dir) => join(dir, 'resources.json');
