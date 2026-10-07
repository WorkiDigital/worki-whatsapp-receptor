import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Journal } from './journal.js';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const key = (...parts) => sha(JSON.stringify(parts)).slice(0, 48);
const safe = (v, max = 300) => typeof v === 'string' ? v.slice(0, max) : '';
const json = async (res) => { try { return await res.json(); } catch { return null; } };

// Escritas mediadas: as credenciais ficam neste processo e o alvo vem de resources.json.
// Este módulo não possui rota genérica nem registra corpos, tokens ou respostas externas.
export class MediatedStore {
  constructor({ dir, now = Date.now } = {}) {
    this.now = now; this.rows = new Map(); this.locks = new Set();
    this.journal = new Journal(join(dir, 'mediated.jsonl'));
    this.journal.open((r) => { if (r.key && r.status) this.rows.set(r.key, r); });
  }
  get(k) { return this.rows.get(k) || null; }
  begin(k, record) {
    const prior = this.rows.get(k);
    if (prior && ['verified', 'failed', 'uncertain'].includes(prior.status)) return prior;
    if (this.locks.has(k)) return { status: 'locked' };
    this.locks.add(k);
    const row = { ...record, key: k, status: 'started', at: this.now() };
    this.journal.append(row); this.rows.set(k, row); return row;
  }
  finish(k, status, extra = {}) {
    const row = { ...(this.rows.get(k) || { key: k }), ...extra, key: k, status, at: this.now() };
    this.journal.append(row); this.rows.set(k, row); this.locks.delete(k); return row;
  }
  release(k) { this.locks.delete(k); }
  close() { this.journal.close(); }
}

const flag = (env, name) => env[name] === 'true';
const disabled = (name) => ({ code: 503, body: { error: 'operation_disabled', flag: name, hint: 'o administrador precisa habilitar esta integração no receptor' } });
const rejected = (http) => ({ kind: 'rejected', http: Number(http) || 502 });
const uncertain = () => ({ kind: 'uncertain' });

function parseRepo(repo) { const [owner, name] = String(repo).split('/'); return { owner, name }; }

export function createMediated({ env = process.env, dir, resources, tasks, access, store = new MediatedStore({ dir }), fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20_000 } = {}) {
  const cfg = resources || { version: 1, clients: {} };
  const call = async (provider, method, path, body, headers = {}) => {
    const base = provider === 'github' ? String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '') : provider === 'vercel' ? String(env.VERCEL_API_URL || 'https://api.vercel.com').replace(/\/$/, '') : 'https://zernio.com/api';
    const token = provider === 'github' ? env.GITHUB_TOKEN : provider === 'vercel' ? env.VERCEL_TOKEN : env.ZERNIO_API_KEY;
    if (!token) return rejected(503);
    const h = { Accept: 'application/json', 'Content-Type': 'application/json', ...headers, Authorization: `Bearer ${token}` };
    if (provider === 'github') h['X-GitHub-Api-Version'] = '2022-11-28';
    let res;
    try { res = await fetchImpl(`${base}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { return uncertain(); }
    const data = await json(res);
    return res.status >= 200 && res.status < 300 ? { kind: 'ok', http: res.status, data } : rejected(res.status);
  };
  const binding = (client) => cfg.clients?.[client] || null;
  const check = (task, client, op) => {
    if (!access?.hasAccess(task.sender)) return { code: 403, body: { error: 'access_revoked' } };
    const can = access.can(task.sender, op, client);
    return can.ok ? null : { code: 403, body: { error: 'forbidden', op, client, reason: can.reason } };
  };
  const beforeProvider = (task, client, op) => check(task, client, op);
  const taskRecord = (task, op, idempotencyKey, status, evidence, platform, ref) => tasks?.recordOp?.({ taskId: task.id, key: idempotencyKey, op, status, evidence, platform, ref });
  const finish = (task, op, k, status, result, platform, ref) => {
    store.finish(k, status, { result });
    taskRecord(task, op, k, status, status === 'verified' ? JSON.stringify(result) : undefined, platform, ref);
  };

  const localPage = (body) => {
    const slug = safe(body.slug, 80);
    const html = typeof body.html === 'string' ? body.html : '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || !html.trim() || Buffer.byteLength(html) > 250_000) return { code: 422, body: { error: 'invalid_page' } };
    if (!/<title(?:\s[^>]*)?>[^<]{1,160}<\/title>/i.test(html)) return { code: 422, body: { error: 'page_title_required' } };
    return { slug, html, digest: sha(html) };
  };

  async function githubCommit({ task, client, page, operation }) {
    const b = binding(client)?.github;
    if (!b) return { kind: 'rejected', code: 422, error: 'github_binding_missing' };
    const { owner, name } = parseRepo(b.repo);
    const ref = await call('github', 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(b.baseBranch)}`);
    if (ref.kind !== 'ok') return ref;
    const baseSha = ref.data?.object?.sha;
    if (!baseSha) return rejected(502);
    const commit = await call('github', 'GET', `/repos/${owner}/${name}/git/commits/${baseSha}`);
    if (commit.kind !== 'ok' || !commit.data?.tree?.sha) return commit.kind === 'uncertain' ? commit : rejected(502);
    const path = `${b.pathPrefix}/${page.slug}/index.html`;
    const tree = await call('github', 'POST', `/repos/${owner}/${name}/git/trees`, { base_tree: commit.data.tree.sha, tree: [{ path, mode: '100644', type: 'blob', content: page.html }] });
    if (tree.kind !== 'ok' || !tree.data?.sha) return tree.kind === 'uncertain' ? tree : rejected(502);
    const message = `chore(worki): publish page ${page.slug}`;
    const made = await call('github', 'POST', `/repos/${owner}/${name}/git/commits`, { message, tree: tree.data.sha, parents: [baseSha] });
    if (made.kind !== 'ok' || !made.data?.sha) return made.kind === 'uncertain' ? made : rejected(502);
    const branch = `agent/${client}/${operation.slice(0, 24)}`;
    let update = await call('github', 'PATCH', `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: made.data.sha, force: false });
    if (update.kind === 'rejected' && (update.http === 404 || update.http === 422)) update = await call('github', 'POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha: made.data.sha });
    if (update.kind !== 'ok') return update.kind === 'uncertain' ? update : rejected(update.http);
    return { kind: 'ok', ref: `${owner}/${name}@${made.data.sha}`, sha: made.data.sha, branch, path };
  }

  async function vercelDeploy({ task, client, page, operation, target }) {
    const b = binding(client)?.vercel;
    if (!b) return { kind: 'rejected', code: 422, error: 'vercel_binding_missing' };
    const body = { name: b.name, project: b.projectId, files: [{ file: 'index.html', data: page.html }], projectSettings: { framework: null }, meta: { workiOperation: operation, workiPageDigest: page.digest } };
    if (target === 'production') body.target = 'production';
    if (b.teamId || env.VERCEL_TEAM_ID) body.teamId = b.teamId || env.VERCEL_TEAM_ID;
    const made = await call('vercel', 'POST', '/v13/deployments', body);
    if (made.kind !== 'ok') return made;
    const id = made.data?.id || made.data?.uid || made.data?.deploymentId;
    if (!id) return rejected(502);
    const query = (b.teamId || env.VERCEL_TEAM_ID) ? `?teamId=${encodeURIComponent(b.teamId || env.VERCEL_TEAM_ID)}` : '';
    let read = null;
    const attempts = Math.max(1, Math.min(Number(env.VERCEL_POLL_ATTEMPTS || 20), 60));
    const pollMs = Math.max(0, Math.min(Number(env.VERCEL_POLL_MS || 500), 5000));
    for (let i = 0; i < attempts; i++) {
      read = await call('vercel', 'GET', `/v13/deployments/${encodeURIComponent(id)}${query}`);
      if (read.kind !== 'ok') return read.kind === 'uncertain' ? read : rejected(502);
      if (read.data?.readyState === 'READY' || read.data?.readyState === 'ERROR' || read.data?.readyState === 'CANCELED') break;
      if (i + 1 < attempts && pollMs) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (read?.data?.readyState !== 'READY') {
      if (['ERROR', 'CANCELED'].includes(read?.data?.readyState)) return { kind: 'rejected', http: 409, state: safe(read.data.readyState, 30) };
      return { kind: 'uncertain' };
    }
    const url = read.data?.url ? `https://${read.data.url}` : (read.data?.alias?.[0] ? `https://${read.data.alias[0]}` : null);
    if (!url || !/^https:\/\/[a-z0-9.-]+\.vercel\.app\/?$/i.test(url)) return rejected(502);
    if (b.allowedHosts.length && !b.allowedHosts.includes(new URL(url).hostname)) return rejected(502);
    let checkRes;
    try { checkRes = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { return uncertain(); }
    if (!checkRes.ok) return rejected(checkRes.status);
    return { kind: 'ok', deploymentId: id, url, readyState: read.data.readyState, http: checkRes.status };
  }

  async function pagePublish({ task, client, body }) {
    if (!flag(env, 'WRITE_GITHUB_ENABLED') || !flag(env, 'WRITE_VERCEL_ENABLED')) return disabled(!flag(env, 'WRITE_GITHUB_ENABLED') ? 'WRITE_GITHUB_ENABLED' : 'WRITE_VERCEL_ENABLED');
    if (!binding(client)?.github || !binding(client)?.vercel) return { code: 422, body: { error: 'resource_not_bound' } };
    const g = check(task, client, body?.target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview') || check(task, client, 'edit_repo'); if (g) return g;
    const page = localPage(body || {}); if (page.code) return page;
    const target = body.target === 'production' ? 'production' : 'preview';
    const op = safe(body.idempotencyKey, 64) || key('page', client, page.slug, page.digest, target);
    const prior = store.get(op);
    if (prior?.status === 'verified') return { code: 200, body: { status: 'verified', replayed: true, result: prior.result } };
    if (prior?.status === 'uncertain' || prior?.status === 'started') return { code: 409, body: { error: 'uncertain_previous_attempt', hint: 'operação em reconciliação; não repetida às cegas' } };
    const started = store.begin(op, { op: 'publish_page', client, digest: page.digest });
    if (started.status === 'locked') return { code: 409, body: { error: 'operation_in_progress' } };
    taskRecord(task, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview', op, 'started', undefined, 'mediated');
    if (beforeProvider(task, client, 'edit_repo')) { store.finish(op, 'failed'); return check(task, client, 'edit_repo'); }
    const gh = await githubCommit({ task, client, page, operation: op });
    if (gh.kind !== 'ok') { const st = gh.kind === 'uncertain' ? 'uncertain' : 'failed'; finish(task, 'edit_repo', op, st, undefined, 'github'); return { code: st === 'uncertain' ? 504 : 502, body: { error: st === 'uncertain' ? 'uncertain' : 'github_error' } }; }
    if (beforeProvider(task, client, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview')) { finish(task, 'edit_repo', op, 'failed', undefined, 'github', gh.ref); return check(task, client, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview'); }
    const vc = await vercelDeploy({ task, client, page, operation: op, target });
    if (vc.kind !== 'ok') { const st = vc.kind === 'uncertain' ? 'uncertain' : 'failed'; finish(task, 'deploy_vercel_production', op, st, undefined, 'vercel', gh.ref); return { code: st === 'uncertain' ? 504 : 502, body: { error: st === 'uncertain' ? 'uncertain' : 'vercel_error' } }; }
    const result = { url: vc.url, deploymentId: safe(vc.deploymentId, 120), githubRef: safe(gh.ref, 300), digest: page.digest, target };
    finish(task, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview', op, 'verified', result, 'vercel', vc.deploymentId);
    return { code: 200, body: { status: 'verified', result } };
  }

  async function instagramPrepare({ task, client, body }) {
    const g = check(task, client, 'prepare_instagram_post'); if (g) return g;
    const caption = typeof body?.caption === 'string' ? body.caption.trim() : '';
    const media = Array.isArray(body?.mediaItems) ? body.mediaItems : [];
    if (!caption || caption.length > 2200 || !media.length || media.some((m) => !m || !['image', 'video'].includes(m.type) || typeof m.url !== 'string' || !/^https:\/\//.test(m.url))) return { code: 422, body: { error: 'invalid_draft' } };
    const account = binding(client)?.zernio?.accountId; if (!account) return { code: 422, body: { error: 'zernio_binding_missing' } };
    const digest = sha(JSON.stringify({ client, account, caption, mediaItems: media }));
    const id = `draft_${digest.slice(0, 24)}`;
    const draft = { id, client, accountId: account, caption, mediaItems: media, contentHash: digest, status: 'prepared', at: now() };
    const k = key('draft', client, id);
    store.finish(k, 'verified', { result: draft });
    return { code: 200, body: { status: 'prepared', draft: { id, contentHash: digest, client, accountId: account, mediaItems: media, caption } } };
  }

  async function instagramPublish({ task, client, body }) {
    if (!flag(env, 'WRITE_ZERNIO_ENABLED')) return disabled('WRITE_ZERNIO_ENABLED');
    const g = check(task, client, 'publish_instagram'); if (g) return g;
    const draftId = safe(body?.draftId, 100); const hash = safe(body?.contentHash, 100);
    if (!draftId || !hash) return { code: 422, body: { error: 'draft_hash_required' } };
    const kDraft = key('draft', client, draftId); const draftRow = store.get(kDraft); const draft = draftRow?.result;
    if (!draft || draft.status !== 'prepared' || draft.contentHash !== hash || draft.client !== client) return { code: 409, body: { error: 'draft_hash_mismatch' } };
    const op = safe(body.idempotencyKey, 64) || key('instagram', client, draftId, hash);
    const prior = store.get(op);
    if (prior?.status === 'verified') return { code: 200, body: { status: 'verified', replayed: true, result: prior.result } };
    if (prior?.status === 'uncertain' || prior?.status === 'started') return { code: 409, body: { error: 'uncertain_previous_attempt' } };
    const started = store.begin(op, { op: 'publish_instagram', client, draftId, contentHash: hash });
    if (started.status === 'locked') return { code: 409, body: { error: 'operation_in_progress' } };
    taskRecord(task, 'publish_instagram', op, 'started', undefined, 'zernio');
    const made = await call('zernio', 'POST', '/v1/posts', { content: draft.caption, mediaItems: draft.mediaItems, platforms: [{ platform: 'instagram', accountId: draft.accountId }], publishNow: true, metadata: { workiOperation: op, workiContentHash: hash } }, { 'Idempotency-Key': op });
    if (made.kind !== 'ok') { finish(task, 'publish_instagram', op, made.kind === 'uncertain' ? 'uncertain' : 'failed', undefined, 'zernio'); return { code: made.kind === 'uncertain' ? 504 : 502, body: { error: made.kind === 'uncertain' ? 'uncertain' : 'zernio_error' } }; }
    const id = made.data?._id || made.data?.id || made.data?.post?._id || made.data?.post?.id;
    if (!id) { finish(task, 'publish_instagram', op, 'uncertain', undefined, 'zernio'); return { code: 504, body: { error: 'uncertain' } }; }
    const read = await call('zernio', 'GET', `/v1/posts/${encodeURIComponent(id)}`);
    if (read.kind !== 'ok') { finish(task, 'publish_instagram', op, read.kind === 'uncertain' ? 'uncertain' : 'failed', undefined, 'zernio', id); return { code: read.kind === 'uncertain' ? 504 : 502, body: { error: read.kind === 'uncertain' ? 'uncertain' : 'zernio_error' } }; }
    const post = read.data?.post || read.data; const platforms = Array.isArray(post?.platforms) ? post.platforms : [];
    const hit = platforms.find((p) => p.accountId?._id === draft.accountId || p.accountId === draft.accountId || p.platform === 'instagram');
    const url = hit?.platformPostUrl || post?.platformPostUrl;
    if (!url || (post?.content && post.content !== draft.caption)) { finish(task, 'publish_instagram', op, 'uncertain', undefined, 'zernio', id); return { code: 409, body: { error: 'verification_failed' } }; }
    const result = { postId: safe(String(id), 120), platformPostUrl: safe(url, 500), contentHash: hash };
    finish(task, 'publish_instagram', op, 'verified', result, 'zernio', String(id));
    return { code: 200, body: { status: 'verified', result } };
  }

  return { enabled: { vercel: flag(env, 'WRITE_VERCEL_ENABLED'), zernio: flag(env, 'WRITE_ZERNIO_ENABLED'), github: flag(env, 'WRITE_GITHUB_ENABLED') }, pagePublish, instagramPrepare, instagramPublish, store, close: () => store.close() };
}
