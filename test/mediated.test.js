import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessStore } from '../lib/access.js';
import { TaskStore } from '../lib/tasks.js';
import { createApi } from '../lib/api.js';
import { createMediated } from '../lib/mediated.js';

const admin = '5585988880001';
const secret = () => randomBytes(32).toString('hex');
const DEFAULT_RESOURCES = { version: 1, clients: { worki: { zernio: { accountId: 'acct_worki', platform: 'instagram' }, github: { repo: 'WorkiDigital/site', baseBranch: 'main', pathPrefix: 'pages' }, vercel: { projectId: 'prj_worki', name: 'worki-site', allowedHosts: [] } } } };

function setup({ flags = {}, resources = DEFAULT_RESOURCES, fetchImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mediated-'));
  const env = { SEND_SECRET: secret(), ADMIN_SENDERS: admin, ...flags };
  const access = new AccessStore({ dir, admins: [admin] });
  const tasks = new TaskStore({ dir });
  const mediated = createMediated({ env, dir, resources, access, tasks, fetchImpl: fetchImpl || (async () => { throw new Error('fetch não deveria ser chamado'); }) });
  const api = createApi({ env, access, tasks, mediated, evo: { sendText: async () => ({ kind: 'ok' }) } });
  const issued = tasks.issue({ eventKey: `test:${randomBytes(5).toString('hex')}`, sender: admin, conv: `${admin}@s.whatsapp.net`, isGroup: false, request: 'teste' });
  tasks.setState(issued.task.id, 'dispatched');
  const call = (path, body) => new Promise((resolve) => api({ method: 'POST', headers: { 'x-send-secret': env.SEND_SECRET, authorization: `Bearer ${issued.token}` }, body }, { status(c) { this.c = c; return this; }, json(o) { resolve({ code: this.c, body: o }); } }, path));
  return { dir, env, access, tasks, mediated, call, close() { mediated.close(); access.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('escritas mediadas nascem desligadas e falham antes de qualquer chamada externa', async () => {
  const w = setup();
  try {
    const page = await w.call('/api/ops/page/publish', { client: 'worki', slug: 'home', html: '<title>Worki</title>' });
    assert.equal(page.code, 503); assert.equal(page.body.error, 'operation_disabled');
    const post = await w.call('/api/ops/instagram/publish', { client: 'worki', draftId: 'draft_x', contentHash: 'x' });
    assert.equal(post.code, 503); assert.equal(post.body.flag, 'WRITE_ZERNIO_ENABLED');
  } finally { w.close(); }
});

test('preparar Instagram guarda rascunho e publicar exige hash do mesmo rascunho', async () => {
  const w = setup();
  try {
    const draft = await w.call('/api/ops/instagram/prepare', { client: 'worki', caption: 'Oferta Worki', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] });
    assert.equal(draft.code, 200); assert.equal(draft.body.status, 'prepared');
    assert.match(draft.body.draft.contentHash, /^[a-f0-9]{64}$/);
    const denied = await w.call('/api/ops/instagram/publish', { client: 'worki', draftId: draft.body.draft.id });
    assert.equal(denied.code, 503, 'a flag desligada é informada antes do hash');
  } finally { w.close(); }
});

test('vínculo privado impede alvo escolhido no pedido', async () => {
  const w = setup({ resources: { version: 1, clients: {} }, flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() } });
  try {
    const out = await w.call('/api/ops/page/publish', { client: 'outro', slug: 'home', html: '<title>x</title>' });
    assert.equal(out.code, 422, 'cliente privado deve ser resolvido pelo vínculo de acesso');
    const out2 = await w.call('/api/ops/page/publish', { client: 'worki', slug: 'home', html: '<title>x</title>' });
    assert.equal(out2.code, 422, 'sem vínculo o mediador não deve chamar a plataforma');
  } finally { w.close(); }
});

test('página mediada usa alvos vinculados, relê Vercel e é idempotente', async () => {
  const tokenGithub = secret(); const tokenVercel = secret(); const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, method: init.method, authorization: init.headers?.Authorization, body: init.body });
    if (url.includes('/git/ref/heads/')) return { status: 200, json: async () => ({ object: { sha: 'base-sha' } }) };
    if (url.includes('/git/commits/base-sha')) return { status: 200, json: async () => ({ tree: { sha: 'tree-base' } }) };
    if (url.endsWith('/git/trees')) return { status: 201, json: async () => ({ sha: 'tree-new' }) };
    if (url.endsWith('/git/commits')) return { status: 201, json: async () => ({ sha: 'commit-new' }) };
    if (url.includes('/git/refs/heads/')) return { status: 200, json: async () => ({ ref: 'refs/heads/agent' }) };
    if (url.endsWith('/deployments')) return { status: 200, json: async () => ({ id: 'dpl-1' }) };
    if (url.includes('/deployments/dpl-1')) return { status: 200, json: async () => ({ readyState: 'READY', url: 'worki-example.vercel.app' }) };
    if (url === 'https://worki-example.vercel.app') return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unexpected fake URL ${url}`);
  };
  const w = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', GITHUB_TOKEN: tokenGithub, VERCEL_TOKEN: tokenVercel }, fetchImpl });
  try {
    const body = { client: 'worki', slug: 'home', html: '<title>Worki</title>', target: 'preview', idempotencyKey: 'page-op-1' };
    const first = await w.call('/api/ops/page/publish', body);
    assert.equal(first.code, 200); assert.equal(first.body.status, 'verified'); assert.equal(first.body.result.url, 'https://worki-example.vercel.app');
    const count = seen.length;
    const replay = await w.call('/api/ops/page/publish', body);
    assert.equal(replay.code, 200); assert.equal(replay.body.replayed, true); assert.equal(seen.length, count);
    assert.ok(seen.some((x) => x.authorization === `Bearer ${tokenGithub}`));
    assert.ok(seen.some((x) => x.authorization === `Bearer ${tokenVercel}`));
    assert.ok(!JSON.stringify(first.body).includes(tokenGithub)); assert.ok(!JSON.stringify(first.body).includes(tokenVercel));
  } finally { w.close(); }
});

test('timeout de publicação externa fica incerto e a repetição não chama o provedor às cegas', async () => {
  let calls = 0;
  const w = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, fetchImpl: async () => { calls++; throw new Error('network'); } });
  try {
    const body = { client: 'worki', slug: 'home', html: '<title>Worki</title>', target: 'preview', idempotencyKey: 'uncertain-op-1' };
    const first = await w.call('/api/ops/page/publish', body);
    assert.equal(first.code, 504); assert.equal(first.body.error, 'uncertain');
    const after = calls;
    const second = await w.call('/api/ops/page/publish', body);
    assert.equal(second.code, 409); assert.equal(second.body.error, 'uncertain_previous_attempt'); assert.equal(calls, after);
  } finally { w.close(); }
});

test('Instagram mediado exige o hash, usa idempotência e verifica o link devolvido pelo Zernio', async () => {
  const zernioToken = secret(); const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, key: init.headers?.['Idempotency-Key'], authorization: init.headers?.Authorization });
    if (init.method === 'POST') return { status: 201, json: async () => ({ _id: 'post-1' }) };
    return { status: 200, json: async () => ({ _id: 'post-1', content: 'Oferta Worki', platforms: [{ platform: 'instagram', accountId: 'acct_worki', platformPostUrl: 'https://instagram.com/p/worki' }] }) };
  };
  const w = setup({ flags: { WRITE_ZERNIO_ENABLED: 'true', ZERNIO_API_KEY: zernioToken }, fetchImpl });
  try {
    const draft = await w.call('/api/ops/instagram/prepare', { client: 'worki', caption: 'Oferta Worki', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] });
    const missing = await w.call('/api/ops/instagram/publish', { client: 'worki', draftId: draft.body.draft.id });
    assert.equal(missing.code, 422); assert.equal(missing.body.error, 'draft_hash_required');
    const body = { client: 'worki', draftId: draft.body.draft.id, contentHash: draft.body.draft.contentHash, idempotencyKey: 'ig-op-1' };
    const first = await w.call('/api/ops/instagram/publish', body);
    assert.equal(first.code, 200); assert.equal(first.body.status, 'verified'); assert.equal(first.body.result.platformPostUrl, 'https://instagram.com/p/worki');
    const count = calls.length;
    const replay = await w.call('/api/ops/instagram/publish', body);
    assert.equal(replay.code, 200); assert.equal(replay.body.replayed, true); assert.equal(calls.length, count);
    assert.ok(calls.filter((c) => c.key).every((c) => c.key !== 'ig-op-1')); 
    assert.ok(!JSON.stringify(first.body).includes(zernioToken));
  } finally { w.close(); }
});

test('Vercel: espera padrão cobre ~60s, aceita proteção explicitamente e só aceita alias permitido', async () => {
  const makeFetch = ({ alias = 'protected.example.test', publicStatus = 403, readyAfter = 1 }) => {
    let reads = 0; let deploys = 0;
    const fetchImpl = async (url, init = {}) => {
      if (url.includes('/git/ref/heads/')) return { status: 200, json: async () => ({ object: { sha: 'base' } }) };
      if (url.includes('/git/commits/base')) return { status: 200, json: async () => ({ tree: { sha: 'tree' } }) };
      if (url.endsWith('/git/trees')) return { status: 201, json: async () => ({ sha: 'tree-new' }) };
      if (url.endsWith('/git/commits')) return { status: 201, json: async () => ({ sha: 'commit-new' }) };
      if (url.includes('/git/refs/heads/')) return { status: 200, json: async () => ({ ref: 'refs/heads/agent' }) };
      if (url.endsWith('/deployments')) { deploys++; return { status: 200, json: async () => ({ id: `dpl-${deploys}` }) }; }
      if (url.includes('/deployments/dpl-')) {
        reads++;
        return { status: 200, json: async () => ({ readyState: reads >= readyAfter ? 'READY' : 'BUILDING', url: alias }) };
      }
      if (url === `https://${alias}`) return { ok: publicStatus >= 200 && publicStatus < 300, status: publicStatus, json: async () => ({}) };
      throw new Error('unexpected fake URL');
    };
    return { fetchImpl, reads: () => reads };
  };

  const protectedCase = makeFetch({ alias: 'preview.worki.test', publicStatus: 403 });
  const accepted = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_ACCEPT_PROTECTED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, resources: { ...DEFAULT_RESOURCES, clients: { worki: { ...DEFAULT_RESOURCES.clients.worki, vercel: { ...DEFAULT_RESOURCES.clients.worki.vercel, allowedHosts: ['preview.worki.test'] } } } }, fetchImpl: protectedCase.fetchImpl });
  try {
    const r = await accepted.call('/api/ops/page/publish', { client: 'worki', slug: 'protected', html: '<title>Protected</title>' });
    assert.equal(r.code, 200); assert.equal(r.body.result.protected, true); assert.equal(r.body.result.publicVerified, false);
  } finally { accepted.close(); }

  const deniedCase = makeFetch({ alias: 'preview.worki.test', publicStatus: 403 });
  const denied = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, resources: { ...DEFAULT_RESOURCES, clients: { worki: { ...DEFAULT_RESOURCES.clients.worki, vercel: { ...DEFAULT_RESOURCES.clients.worki.vercel, allowedHosts: ['preview.worki.test'] } } } }, fetchImpl: deniedCase.fetchImpl });
  try {
    const r = await denied.call('/api/ops/page/publish', { client: 'worki', slug: 'protected', html: '<title>Protected</title>' });
    assert.equal(r.code, 502); assert.equal(r.body.error, 'vercel_error');
  } finally { denied.close(); }

  const unlistedCase = makeFetch({ alias: 'not-allowed.example.test', publicStatus: 200 });
  const unlisted = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, fetchImpl: unlistedCase.fetchImpl });
  try {
    const r = await unlisted.call('/api/ops/page/publish', { client: 'worki', slug: 'alias', html: '<title>Alias</title>' });
    assert.equal(r.code, 502); assert.equal(r.body.error, 'vercel_error');
  } finally { unlisted.close(); }

  const long = makeFetch({ alias: 'long.worki.test', publicStatus: 200, readyAfter: 21 });
  const waited = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, resources: { ...DEFAULT_RESOURCES, clients: { worki: { ...DEFAULT_RESOURCES.clients.worki, vercel: { ...DEFAULT_RESOURCES.clients.worki.vercel, allowedHosts: ['long.worki.test'] } } } }, fetchImpl: long.fetchImpl });
  try {
    const r = await waited.call('/api/ops/page/publish', { client: 'worki', slug: 'long', html: '<title>Long</title>' });
    assert.equal(r.code, 200); assert.equal(long.reads(), 21, 'a janela padrão menor que 60s não pode encerrar após 20 tentativas');
  } finally { waited.close(); }
});


test('idempotência mediada: cliente e hash entram na chave; nova chave não duplica após reconciliação', async () => {
  const otherResources = { version: 1, clients: { ...DEFAULT_RESOURCES.clients, other: { ...DEFAULT_RESOURCES.clients.worki, github: { ...DEFAULT_RESOURCES.clients.worki.github, repo: 'WorkiDigital/other' }, vercel: { ...DEFAULT_RESOURCES.clients.worki.vercel, projectId: 'prj_other', name: 'other-site' }, zernio: { ...DEFAULT_RESOURCES.clients.worki.zernio, accountId: 'acct_other' } } } };
  let deploys = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/git/ref/heads/')) return { status: 200, json: async () => ({ object: { sha: 'base' } }) };
    if (url.includes('/git/commits/base')) return { status: 200, json: async () => ({ tree: { sha: 'tree' } }) };
    if (url.endsWith('/git/trees')) return { status: 201, json: async () => ({ sha: 'tree-new' }) };
    if (url.endsWith('/git/commits')) return { status: 201, json: async () => ({ sha: 'commit-new' }) };
    if (url.includes('/git/refs/heads/')) return { status: 200, json: async () => ({ ref: 'refs/heads/agent' }) };
    if (url.endsWith('/deployments')) { deploys++; return { status: 200, json: async () => ({ id: `dpl-${deploys}` }) }; }
    if (url.includes('/deployments/dpl-')) return { status: 200, json: async () => ({ readyState: 'READY', url: `site-${deploys}.vercel.app` }) };
    if (url.startsWith('https://site-')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('unexpected fake URL');
  };
  const w = setup({ resources: otherResources, flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, fetchImpl });
  try {
    const body = { slug: 'same', html: '<title>Same</title>', target: 'preview', idempotencyKey: 'caller-key' };
    const first = await w.call('/api/ops/page/publish', { ...body, client: 'worki' });
    const second = await w.call('/api/ops/page/publish', { ...body, client: 'other' });
    assert.equal(first.code, 200); assert.equal(second.code, 200); assert.notEqual(second.body.replayed, true); assert.equal(deploys, 2);
  } finally { w.close(); }

});
