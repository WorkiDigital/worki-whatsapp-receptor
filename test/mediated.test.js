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

function setup({ flags = {}, resources = DEFAULT_RESOURCES, fetchImpl, now = Date.now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mediated-'));
  const env = { SEND_SECRET: secret(), ADMIN_SENDERS: admin, ...flags };
  const access = new AccessStore({ dir, admins: [admin] });
  const tasks = new TaskStore({ dir });
  const mediated = createMediated({ env, dir, resources, access, tasks, now, fetchImpl: fetchImpl || (async () => { throw new Error('fetch não deveria ser chamado'); }) });
  const api = createApi({ env, access, tasks, mediated, evo: { sendText: async () => ({ kind: 'ok' }) } });
  const issued = tasks.issue({ eventKey: `test:${randomBytes(5).toString('hex')}`, sender: admin, conv: `${admin}@s.whatsapp.net`, isGroup: false, request: 'teste' });
  tasks.setState(issued.task.id, 'dispatched');
  const callTask = (taskIssued, path, body) => new Promise((resolve) => api({ method: 'POST', headers: { 'x-send-secret': env.SEND_SECRET, authorization: `Bearer ${taskIssued.token}` }, body }, { status(c) { this.c = c; return this; }, json(o) { resolve({ code: this.c, body: o }); } }, path));
  const call = (path, body) => callTask(issued, path, body);
  return { dir, env, access, tasks, mediated, issued, call, callTask, taskIssued: (sender = admin) => { const x = tasks.issue({ eventKey: `test:${randomBytes(5).toString('hex')}`, sender, conv: `${sender}@s.whatsapp.net`, isGroup: false, request: 'teste' }); tasks.setState(x.task.id, 'dispatched'); return x; }, close() { mediated.close(); access.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }); } };
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

  let pageOp; let postCalls = 0; let listCalls = 0;
  const reconcileFetch = async (url, init = {}) => {
    if (url.includes('/git/ref/heads/')) return { status: 200, json: async () => ({ object: { sha: 'base' } }) };
    if (url.includes('/git/commits/base')) return { status: 200, json: async () => ({ tree: { sha: 'tree' } }) };
    if (url.endsWith('/git/trees')) return { status: 201, json: async () => ({ sha: 'tree-new' }) };
    if (url.endsWith('/git/commits')) return { status: 201, json: async () => ({ sha: 'commit-new' }) };
    if (url.includes('/git/refs/heads/')) return { status: 200, json: async () => ({ ref: 'refs/heads/agent' }) };
    if (url.endsWith('/deployments')) { postCalls++; pageOp = JSON.parse(init.body).meta.workiOperation; throw new Error('lost response'); }
    if (url.includes('/v7/deployments?')) { listCalls++; return { status: 200, json: async () => ({ deployments: [{ uid: 'dpl-existing', meta: { workiOperation: pageOp, workiPageDigest: 'digest-placeholder' } }] }) }; }
    if (url.includes('/deployments/dpl-existing')) return { status: 200, json: async () => ({ readyState: 'READY', url: 'reconciled.vercel.app' }) };
    if (url === 'https://reconciled.vercel.app') return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('unexpected fake URL');
  };
  // The digest is captured from the deployment body so the provider listing can prove the same content.
  const original = reconcileFetch;
  const w2 = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, fetchImpl: async (url, init = {}) => {
    if (url.endsWith('/deployments') && init.method === 'POST') {
      const body = JSON.parse(init.body); pageOp = body.meta.workiOperation; reconcileFetch.digest = body.meta.workiPageDigest;
    }
    const result = await original(url, init);
    if (url.includes('/v7/deployments?') && result?.json) {
      const data = await result.json(); return { status: 200, json: async () => ({ deployments: [{ uid: 'dpl-existing', meta: { workiOperation: pageOp, workiPageDigest: reconcileFetch.digest } }] }) };
    }
    return result;
  } });
  try {
    const first = await w2.call('/api/ops/page/publish', { client: 'worki', slug: 'uncertain', html: '<title>Uncertain</title>', idempotencyKey: 'key-a' });
    const second = await w2.call('/api/ops/page/publish', { client: 'worki', slug: 'uncertain', html: '<title>Uncertain</title>', idempotencyKey: 'key-b' });
    assert.equal(first.code, 504); assert.equal(second.code, 200); assert.equal(second.body.reconciled, true); assert.equal(postCalls, 1); assert.equal(listCalls, 1);
  } finally { w2.close(); }
});

test('Instagram: chave nova reconcilia publicação incerta pelo metadata sem repetir o POST', async () => {
  let operation; let contentHash; let posts = 0; let lists = 0; let reads = 0;
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST' && url.endsWith('/v1/posts')) {
      posts++;
      const body = JSON.parse(init.body);
      operation = body.metadata.workiOperation;
      contentHash = body.metadata.workiContentHash;
      throw new Error('resposta perdida');
    }
    if (url.startsWith('https://zernio.com/api/v1/posts?')) {
      lists++;
      return { status: 200, json: async () => ({ posts: [{ _id: 'post-reconciled', metadata: { workiOperation: operation, workiContentHash: contentHash }, content: 'Oferta Incerta', platforms: [{ platform: 'instagram', accountId: 'acct_worki' }] }] }) };
    }
    if (url.endsWith('/v1/posts/post-reconciled')) {
      reads++;
      return { status: 200, json: async () => ({ _id: 'post-reconciled', status: 'published', content: 'Oferta Incerta', platforms: [{ platform: 'instagram', accountId: 'acct_worki', platformPostUrl: 'https://instagram.com/p/reconciled' }] }) };
    }
    throw new Error(`unexpected fake URL ${url}`);
  };
  const w = setup({ flags: { WRITE_ZERNIO_ENABLED: 'true', ZERNIO_API_KEY: secret() }, fetchImpl });
  try {
    const draft = await w.call('/api/ops/instagram/prepare', { client: 'worki', caption: 'Oferta Incerta', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] });
    const base = { client: 'worki', draftId: draft.body.draft.id, contentHash: draft.body.draft.contentHash };
    const first = await w.call('/api/ops/instagram/publish', { ...base, idempotencyKey: 'first-key' });
    const second = await w.call('/api/ops/instagram/publish', { ...base, idempotencyKey: 'different-key' });
    assert.equal(first.code, 504);
    assert.equal(second.code, 200);
    assert.equal(second.body.reconciled, true);
    assert.equal(second.body.result.postId, 'post-reconciled');
    assert.equal(posts, 1);
    assert.equal(lists, 1);
    assert.equal(reads, 1);
  } finally { w.close(); }
});

test('recuperação reavalia operação incerta ao iniciar e marca a evidência encontrada', async () => {
  let operation; let digest; let deploymentLists = 0; let deploymentReads = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/git/ref/heads/')) return { status: 200, json: async () => ({ object: { sha: 'base' } }) };
    if (url.includes('/git/commits/base')) return { status: 200, json: async () => ({ tree: { sha: 'tree' } }) };
    if (url.endsWith('/git/trees')) return { status: 201, json: async () => ({ sha: 'tree-new' }) };
    if (url.endsWith('/git/commits')) return { status: 201, json: async () => ({ sha: 'commit-new' }) };
    if (url.includes('/git/refs/heads/')) return { status: 200, json: async () => ({ ref: 'refs/heads/agent' }) };
    if (url.endsWith('/deployments')) {
      const body = JSON.parse(init.body); operation = body.meta.workiOperation; digest = body.meta.workiPageDigest;
      throw new Error('resposta perdida');
    }
    if (url.includes('/v7/deployments?')) {
      deploymentLists++;
      return { status: 200, json: async () => ({ deployments: [{ uid: 'dpl-recovered', meta: { workiOperation: operation, workiPageDigest: digest } }] }) };
    }
    if (url.includes('/deployments/dpl-recovered')) {
      deploymentReads++;
      return { status: 200, json: async () => ({ readyState: 'READY', url: 'recovered.vercel.app' }) };
    }
    if (url === 'https://recovered.vercel.app') return { ok: true, status: 200, json: async () => ({}) };
    throw new Error(`unexpected fake URL ${url}`);
  };
  const w = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: secret(), VERCEL_TOKEN: secret() }, fetchImpl });
  try {
    const first = await w.call('/api/ops/page/publish', { client: 'worki', slug: 'recover', html: '<title>Recover</title>', idempotencyKey: 'first' });
    assert.equal(first.code, 504);
    const recovered = await w.mediated.recover();
    assert.deepEqual(recovered, { scanned: 1, found: 1, unknown: 0 });
    assert.equal(deploymentLists, 1);
    assert.equal(deploymentReads, 1);
    const replay = await w.call('/api/ops/page/publish', { client: 'worki', slug: 'recover', html: '<title>Recover</title>', idempotencyKey: 'new-key' });
    assert.equal(replay.code, 200);
    assert.equal(replay.body.replayed, true);
  } finally { w.close(); }
});

test('Instagram: publicação fica presa ao remetente, expira e respeita allowlist de mídia', async () => {
  const clock = { t: 1_800_000_000_000 };
  const resources = { version: 1, clients: { worki: { ...DEFAULT_RESOURCES.clients.worki, mediaAllowedHosts: ['cdn.allowed.test'] } } };
  const w = setup({ resources, now: () => clock.t, flags: { INSTAGRAM_DRAFT_TTL_HOURS: '1', WRITE_ZERNIO_ENABLED: 'true', ZERNIO_API_KEY: secret() } });
  const other = '5585988887777';
  try {
    w.access.grant({ by: admin, number: other, clients: ['worki'], ops: ['prepare_instagram_post', 'publish_instagram'] });
    const outside = await w.call('/api/ops/instagram/prepare', { client: 'worki', caption: 'x', mediaItems: [{ type: 'image', url: 'https://cdn.other.test/a.jpg' }] });
    assert.equal(outside.code, 422); assert.equal(outside.body.error, 'media_host_not_allowed');
    const draft = await w.call('/api/ops/instagram/prepare', { client: 'worki', caption: 'x', mediaItems: [{ type: 'image', url: 'https://cdn.allowed.test/a.jpg' }] });
    const denied = await w.callTask(w.taskIssued(other), '/api/ops/instagram/publish', { client: 'worki', draftId: draft.body.draft.id, contentHash: draft.body.draft.contentHash });
    assert.equal(denied.code, 403); assert.equal(denied.body.error, 'draft_owner_mismatch');
    const otherDraft = await w.callTask(w.taskIssued(other), '/api/ops/instagram/prepare', { client: 'worki', caption: 'x', mediaItems: [{ type: 'image', url: 'https://cdn.allowed.test/a.jpg' }] });
    assert.notEqual(otherDraft.body.draft.id, draft.body.draft.id, 'outro remetente não sobrescreve a propriedade do rascunho');
    clock.t += 3_600_001;
    const expired = await w.call('/api/ops/instagram/publish', { client: 'worki', draftId: draft.body.draft.id, contentHash: draft.body.draft.contentHash });
    assert.equal(expired.code, 409); assert.equal(expired.body.error, 'draft_expired');
  } finally { w.close(); }
});

test('lista vazia não prova ausência nem permite duplicar publicação incerta', async () => {
  let posts = 0;
  const w = setup({ flags: { WRITE_ZERNIO_ENABLED: 'true', ZERNIO_API_KEY: secret() }, fetchImpl: async (_url, init) => {
    if (init.method === 'POST') { posts++; throw new Error('timeout'); }
    return { status: 200, json: async () => ({ posts: [], pagination: { next: 2 } }) };
  } });
  try {
    const d = (await w.call('/api/ops/instagram/prepare', { client: 'worki', caption: 'Teste', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] })).body.draft;
    const body = { client: 'worki', draftId: d.id, contentHash: d.contentHash };
    assert.equal((await w.call('/api/ops/instagram/publish', body)).code, 504);
    assert.equal((await w.call('/api/ops/instagram/publish', { ...body, idempotencyKey: 'outra' })).code, 409);
    assert.equal(posts, 1);
  } finally { w.close(); }
});

test('logs mediados registram provedor/estado/http sem corpo, segredo, conteúdo ou URL privada', async () => {
  const token = secret(); const lines = []; const original = console.log; console.log = (...args) => lines.push(args.join(' '));
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/git/ref/heads/')) return { status: 200, json: async () => ({ object: { sha: 'base' } }) };
    if (url.includes('/git/commits/base')) return { status: 200, json: async () => ({ tree: { sha: 'tree' } }) };
    if (url.endsWith('/git/trees')) return { status: 201, json: async () => ({ sha: 'tree-new' }) };
    if (url.endsWith('/git/commits')) return { status: 201, json: async () => ({ sha: 'commit-new' }) };
    if (url.includes('/git/refs/heads/')) return { status: 200, json: async () => ({ ref: 'refs/heads/agent' }) };
    if (url.endsWith('/deployments')) return { status: 200, json: async () => ({ id: 'dpl-log' }) };
    if (url.includes('/deployments/dpl-log')) return { status: 200, json: async () => ({ readyState: 'READY', url: 'private.example.test' }) };
    if (url === 'https://private.example.test') return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('unexpected fake URL');
  };
  const w = setup({ flags: { WRITE_GITHUB_ENABLED: 'true', WRITE_VERCEL_ENABLED: 'true', VERCEL_POLL_MS: '0', GITHUB_TOKEN: token, VERCEL_TOKEN: secret() }, resources: { ...DEFAULT_RESOURCES, clients: { worki: { ...DEFAULT_RESOURCES.clients.worki, vercel: { ...DEFAULT_RESOURCES.clients.worki.vercel, allowedHosts: ['private.example.test'] } } } }, fetchImpl });
  try {
    const r = await w.call('/api/ops/page/publish', { client: 'worki', slug: 'log', html: '<title>private-content</title>' });
    assert.equal(r.code, 200);
    const logText = lines.join('\n');
    assert.match(logText, /mediated_provider/); assert.match(logText, /vercel/); assert.match(logText, /http/);
    assert.ok(!logText.includes(token)); assert.ok(!logText.includes('private-content')); assert.ok(!logText.includes('private.example.test'));
  } finally { console.log = original; w.close(); }
});
