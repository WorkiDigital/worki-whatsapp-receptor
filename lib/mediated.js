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
  // Atualiza metadados do estágio sem liberar o bloqueio. Usado para guardar
  // a evidência necessária à reconciliação depois de uma queda.
  update(k, extra = {}) {
    const prior = this.rows.get(k);
    if (!prior) return null;
    const row = { ...prior, ...extra, key: k, status: prior.status, at: this.now() };
    this.journal.append(row); this.rows.set(k, row); return row;
  }
  // Só é chamado depois de uma consulta ao provedor confirmar que a tentativa
  // anterior está ausente. Reabre a mesma chave canônica, sem criar duplicata.
  restart(k, record) {
    if (this.locks.has(k)) return { status: 'locked' };
    const row = { ...(this.rows.get(k) || {}), ...record, key: k, status: 'started', at: this.now() };
    this.journal.append(row); this.rows.set(k, row); this.locks.add(k); return row;
  }
  entries() { return [...this.rows.values()]; }
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
  const audit = (event, { operation = 'unknown', provider = 'unknown', state, http } = {}) => {
    const row = { event, operation: safe(operation, 80), provider: safe(provider, 20), state: safe(state, 30) };
    if (Number.isInteger(http)) row.http = http;
    console.log(JSON.stringify(row));
  };
  const call = async (provider, method, path, body, headers = {}, meta = {}) => {
    const base = provider === 'github' ? String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '') : provider === 'vercel' ? String(env.VERCEL_API_URL || 'https://api.vercel.com').replace(/\/$/, '') : 'https://zernio.com/api';
    const token = provider === 'github' ? env.GITHUB_TOKEN : provider === 'vercel' ? env.VERCEL_TOKEN : env.ZERNIO_API_KEY;
    if (!token) { audit('mediated_provider', { operation: meta.operation, provider, state: 'rejected', http: 503 }); return rejected(503); }
    const h = { Accept: 'application/json', 'Content-Type': 'application/json', ...headers, Authorization: `Bearer ${token}` };
    if (provider === 'github') h['X-GitHub-Api-Version'] = '2022-11-28';
    let res;
    try { res = await fetchImpl(`${base}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) }); }
    catch { audit('mediated_provider', { operation: meta.operation, provider, state: 'uncertain' }); return uncertain(); }
    const data = await json(res);
    const result = res.status >= 200 && res.status < 300 ? { kind: 'ok', http: res.status, data } : rejected(res.status);
    audit('mediated_provider', { operation: meta.operation, provider, state: result.kind === 'ok' ? 'ok' : 'rejected', http: res.status });
    return result;
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
    audit('mediated_operation', { operation: op, provider: platform, state: status });
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
    const ref = await call('github', 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(b.baseBranch)}`, undefined, {}, { operation });
    if (ref.kind !== 'ok') return ref;
    const baseSha = ref.data?.object?.sha;
    if (!baseSha) return rejected(502);
    const commit = await call('github', 'GET', `/repos/${owner}/${name}/git/commits/${baseSha}`, undefined, {}, { operation });
    if (commit.kind !== 'ok' || !commit.data?.tree?.sha) return commit.kind === 'uncertain' ? commit : rejected(502);
    const path = `${b.pathPrefix}/${page.slug}/index.html`;
    const tree = await call('github', 'POST', `/repos/${owner}/${name}/git/trees`, { base_tree: commit.data.tree.sha, tree: [{ path, mode: '100644', type: 'blob', content: page.html }] }, {}, { operation });
    if (tree.kind !== 'ok' || !tree.data?.sha) return tree.kind === 'uncertain' ? tree : rejected(502);
    const message = `chore(worki): publish page ${page.slug}`;
    const made = await call('github', 'POST', `/repos/${owner}/${name}/git/commits`, { message, tree: tree.data.sha, parents: [baseSha] }, {}, { operation });
    if (made.kind !== 'ok' || !made.data?.sha) return made.kind === 'uncertain' ? made : rejected(502);
    const branch = `agent/${client}/${operation.slice(0, 24)}`;
    let update = await call('github', 'PATCH', `/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: made.data.sha, force: false }, {}, { operation });
    if (update.kind === 'rejected' && (update.http === 404 || update.http === 422)) update = await call('github', 'POST', `/repos/${owner}/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha: made.data.sha }, {}, { operation });
    if (update.kind !== 'ok') return update.kind === 'uncertain' ? update : rejected(update.http);
    return { kind: 'ok', ref: `${owner}/${name}@${made.data.sha}`, sha: made.data.sha, branch, path };
  }

  const vercelQuery = (b) => (b.teamId || env.VERCEL_TEAM_ID) ? `?teamId=${encodeURIComponent(b.teamId || env.VERCEL_TEAM_ID)}` : '';
  const publicUrl = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    try { return new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`); }
    catch { return null; }
  };
  async function verifyVercelReady({ id, read, b, operation }) {
    if (read?.readyState !== 'READY') {
      if (['ERROR', 'CANCELED'].includes(read?.readyState)) return { kind: 'rejected', http: 409, state: safe(read.readyState, 30) };
      return { kind: 'uncertain' };
    }
    const parsed = publicUrl(read.url || read.alias?.[0]);
    if (!parsed || parsed.protocol !== 'https:') return rejected(502);
    const host = parsed.hostname.toLowerCase();
    const allowed = (b.allowedHosts || []).map((h) => String(h).toLowerCase());
    if (!host.endsWith('.vercel.app') && !allowed.includes(host)) return rejected(502);
    const url = parsed.toString().replace(/\/$/, '');
    let checkRes;
    try { checkRes = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { audit('mediated_verification', { operation, provider: 'vercel', state: 'uncertain' }); return uncertain(); }
    if ((checkRes.status === 401 || checkRes.status === 403) && flag(env, 'VERCEL_ACCEPT_PROTECTED')) {
      return { kind: 'ok', deploymentId: id, url, readyState: read.readyState, http: checkRes.status, protected: true, publicVerified: false };
    }
    if (!checkRes.ok) return rejected(checkRes.status);
    return { kind: 'ok', deploymentId: id, url, readyState: read.readyState, http: checkRes.status, protected: false, publicVerified: true };
  }
  async function pollVercel({ id, b, operation, first = null }) {
    const attempts = Math.max(1, Math.min(Number(env.VERCEL_POLL_ATTEMPTS || 120), 180));
    const pollMs = Math.max(0, Math.min(Number(env.VERCEL_POLL_MS || 500), 5000));
    let read = first;
    for (let i = 0; i < attempts; i++) {
      if (!read) read = await call('vercel', 'GET', `/v13/deployments/${encodeURIComponent(id)}${vercelQuery(b)}`, undefined, {}, { operation });
      if (read.kind !== 'ok') return read.kind === 'uncertain' ? read : rejected(read.http || 502);
      if (read.data?.readyState === 'READY' || read.data?.readyState === 'ERROR' || read.data?.readyState === 'CANCELED') break;
      read = null;
      if (i + 1 < attempts && pollMs) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return verifyVercelReady({ id, read: read?.data, b, operation });
  }
  async function vercelDeploy({ client, page, operation, target }) {
    const b = binding(client)?.vercel;
    if (!b) return { kind: 'rejected', code: 422, error: 'vercel_binding_missing' };
    const body = { name: b.name, project: b.projectId, files: [{ file: 'index.html', data: page.html }], projectSettings: { framework: null }, meta: { workiOperation: operation, workiPageDigest: page.digest } };
    if (target === 'production') body.target = 'production';
    if (b.teamId || env.VERCEL_TEAM_ID) body.teamId = b.teamId || env.VERCEL_TEAM_ID;
    const made = await call('vercel', 'POST', '/v13/deployments', body, {}, { operation });
    if (made.kind !== 'ok') return made;
    const id = made.data?.id || made.data?.uid || made.data?.deploymentId;
    if (!id) return rejected(502);
    return pollVercel({ id, b, operation });
  }

  async function reconcileVercel({ client, page, operation, prior }) {
    const b = binding(client)?.vercel;
    if (!b) return { kind: 'unknown' };
    const since = Math.max(0, Number(prior.at || now()) - 86_400_000);
    const query = new URLSearchParams({ projectId: b.projectId, limit: '100', since: String(since) });
    if (b.teamId || env.VERCEL_TEAM_ID) query.set('teamId', b.teamId || env.VERCEL_TEAM_ID);
    const listed = await call('vercel', 'GET', `/v7/deployments?${query}`, undefined, {}, { operation });
    if (listed.kind !== 'ok') return { kind: 'unknown' };
    const deployments = Array.isArray(listed.data?.deployments) ? listed.data.deployments : [];
    const hit = deployments.find((d) => d?.meta?.workiOperation === operation && d?.meta?.workiPageDigest === page.digest);
    // Uma página de listagem (e sua consistência eventual) não prova ausência.
    if (!hit) return { kind: 'unknown' };
    const id = hit.uid || hit.id || hit.deploymentId;
    if (!id) return { kind: 'unknown' };
    const checked = await pollVercel({ id, b, operation });
    return checked.kind === 'ok' ? { kind: 'found', result: { ...checked, digest: page.digest } } : checked.kind === 'rejected' ? { kind: 'unknown' } : { kind: 'unknown' };
  }

  const mediaHosts = (client) => (Array.isArray(binding(client)?.mediaAllowedHosts) ? binding(client).mediaAllowedHosts : []).map((h) => String(h).toLowerCase());
  const mediaAllowed = (client, media) => {
    const allowed = mediaHosts(client);
    if (!allowed.length) return true;
    return media.every((item) => {
      try { return allowed.includes(new URL(item.url).hostname.toLowerCase()); } catch { return false; }
    });
  };
  const zernioPostId = (data) => data?._id || data?.id || data?.post?._id || data?.post?.id;
  const verifyZernioPost = (data, draft, id) => {
    const post = data?.post || data;
    const platforms = Array.isArray(post?.platforms) ? post.platforms : [];
    const hit = platforms.find((p) => p.accountId?._id === draft.accountId || p.accountId === draft.accountId);
    const url = hit?.platformPostUrl;
    if (!url || (post?.content && post.content !== draft.caption)) return { kind: 'unknown' };
    if (post?.status && !['published', 'partial'].includes(post.status)) return { kind: 'unknown' };
    return { kind: 'found', result: { postId: safe(String(id || zernioPostId(data)), 120), platformPostUrl: safe(url, 500), contentHash: draft.contentHash } };
  };
  async function reconcileZernio({ client, draft, operation, prior }) {
    const account = binding(client)?.zernio?.accountId;
    if (!account) return { kind: 'unknown' };
    const from = new Date(Math.max(0, Number(prior.at || now()) - 86_400_000)).toISOString();
    const to = new Date(now() + 60_000).toISOString();
    const query = new URLSearchParams({ accountId: account, fromDate: from, toDate: to, limit: '100' });
    const listed = await call('zernio', 'GET', `/v1/posts?${query}`, undefined, {}, { operation });
    if (listed.kind !== 'ok') return { kind: 'unknown' };
    const posts = Array.isArray(listed.data?.posts) ? listed.data.posts : [];
    const hit = posts.find((p) => p?.metadata?.workiOperation === operation || (p?.metadata?.workiContentHash === draft.contentHash && p?.platforms?.some((x) => x.accountId?._id === account || x.accountId === account)));
    if (!hit) return { kind: 'unknown' };
    const id = zernioPostId(hit);
    if (!id) return { kind: 'unknown' };
    const read = await call('zernio', 'GET', `/v1/posts/${encodeURIComponent(id)}`, undefined, {}, { operation });
    if (read.kind !== 'ok') return { kind: 'unknown' };
    return verifyZernioPost(read.data, draft, id);
  }

  async function pagePublish({ task, client, body }) {
    if (!flag(env, 'WRITE_GITHUB_ENABLED') || !flag(env, 'WRITE_VERCEL_ENABLED')) return disabled(!flag(env, 'WRITE_GITHUB_ENABLED') ? 'WRITE_GITHUB_ENABLED' : 'WRITE_VERCEL_ENABLED');
    if (!binding(client)?.github || !binding(client)?.vercel) return { code: 422, body: { error: 'resource_not_bound' } };
    const g = check(task, client, body?.target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview') || check(task, client, 'edit_repo'); if (g) return g;
    const page = localPage(body || {}); if (page.code) return page;
    const target = body.target === 'production' ? 'production' : 'preview';
    // A chave do chamador é apenas uma referência de retry. A identidade da
    // operação é sempre derivada de cliente + operação + conteúdo + alvo.
    // Assim, uma chave repetida não cruza clientes e uma chave nova não duplica
    // o mesmo conteúdo depois de um timeout.
    const op = key('worki:page:publish', client, target, page.digest);
    const prior = store.get(op);
    if (store.locks.has(op)) return { code: 409, body: { error: 'operation_in_progress' } };
    if (prior?.status === 'verified') return { code: 200, body: { status: 'verified', replayed: true, result: prior.result } };
    if (prior?.status === 'uncertain' || prior?.status === 'started') {
      if (prior.provider === 'vercel' || prior.stage === 'vercel') {
        const reconciled = await reconcileVercel({ client, page, operation: op, prior });
        if (reconciled.kind === 'found') {
          const result = { url: reconciled.result.url, deploymentId: safe(reconciled.result.deploymentId, 120), githubRef: safe(prior.githubRef, 300), digest: page.digest, target, protected: Boolean(reconciled.result.protected), publicVerified: Boolean(reconciled.result.publicVerified) };
          finish(task, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview', op, 'verified', result, 'vercel', reconciled.result.deploymentId);
          return { code: 200, body: { status: 'verified', reconciled: true, result } };
        }
        if (reconciled.kind !== 'absent') return { code: 409, body: { error: 'uncertain_previous_attempt', hint: 'não foi possível confirmar a implantação na Vercel' } };
      } else {
        return { code: 409, body: { error: 'uncertain_previous_attempt', hint: 'resultado anterior incerto; provedor sem reconciliação confirmada' } };
      }
    }
    const started = prior?.status === 'uncertain' || prior?.status === 'started'
      ? store.restart(op, { op: 'publish_page', client, digest: page.digest, target, taskId: task.id })
      : store.begin(op, { op: 'publish_page', client, digest: page.digest, target, taskId: task.id });
    if (started.status === 'locked') return { code: 409, body: { error: 'operation_in_progress' } };
    taskRecord(task, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview', op, 'started', undefined, 'mediated');
    if (beforeProvider(task, client, 'edit_repo')) { store.finish(op, 'failed'); return check(task, client, 'edit_repo'); }
    const gh = started.stage === 'vercel' && started.githubRef ? { kind: 'ok', ref: started.githubRef, sha: started.githubSha } : await githubCommit({ task, client, page, operation: op });
    if (gh.kind !== 'ok') { const st = gh.kind === 'uncertain' ? 'uncertain' : 'failed'; finish(task, 'edit_repo', op, st, undefined, 'github'); return { code: st === 'uncertain' ? 504 : 502, body: { error: st === 'uncertain' ? 'uncertain' : 'github_error' } }; }
    if (beforeProvider(task, client, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview')) { finish(task, 'edit_repo', op, 'failed', undefined, 'github', gh.ref); return check(task, client, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview'); }
    store.update(op, { stage: 'vercel', provider: 'vercel', githubRef: gh.ref, githubSha: gh.sha });
    const vc = await vercelDeploy({ client, page, operation: op, target });
    if (vc.kind !== 'ok') { const st = vc.kind === 'uncertain' ? 'uncertain' : 'failed'; if (vc.deploymentId) store.update(op, { providerRef: vc.deploymentId }); finish(task, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview', op, st, undefined, 'vercel', gh.ref); return { code: st === 'uncertain' ? 504 : 502, body: { error: st === 'uncertain' ? 'uncertain' : 'vercel_error' } }; }
    const result = { url: vc.url, deploymentId: safe(vc.deploymentId, 120), githubRef: safe(gh.ref, 300), digest: page.digest, target, protected: Boolean(vc.protected), publicVerified: Boolean(vc.publicVerified) };
    finish(task, target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview', op, 'verified', result, 'vercel', vc.deploymentId);
    return { code: 200, body: { status: 'verified', result } };
  }

  async function instagramPrepare({ task, client, body }) {
    const g = check(task, client, 'prepare_instagram_post'); if (g) return g;
    const caption = typeof body?.caption === 'string' ? body.caption.trim() : '';
    const media = Array.isArray(body?.mediaItems) ? body.mediaItems : [];
    if (!caption || caption.length > 2200 || !media.length || media.some((m) => !m || !['image', 'video'].includes(m.type) || typeof m.url !== 'string' || !/^https:\/\//.test(m.url))) return { code: 422, body: { error: 'invalid_draft' } };
    if (!mediaAllowed(client, media)) return { code: 422, body: { error: 'media_host_not_allowed' } };
    const account = binding(client)?.zernio?.accountId; if (!account) return { code: 422, body: { error: 'zernio_binding_missing' } };
    const digest = sha(JSON.stringify({ client, account, caption, mediaItems: media }));
    const id = `draft_${key(client, task.sender, digest).slice(0, 24)}`;
    const ttlHours = Math.max(1, Math.min(Number(env.INSTAGRAM_DRAFT_TTL_HOURS || 24), 24 * 30));
    const draft = { id, client, sender: task.sender, accountId: account, caption, mediaItems: media, contentHash: digest, status: 'prepared', at: now(), expiresAt: now() + ttlHours * 3_600_000 };
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
    if (draft.sender !== task.sender) return { code: 403, body: { error: 'draft_owner_mismatch' } };
    if (Number.isFinite(draft.expiresAt) && draft.expiresAt <= now()) return { code: 409, body: { error: 'draft_expired' } };
    if (!mediaAllowed(client, draft.mediaItems)) return { code: 422, body: { error: 'media_host_not_allowed' } };
    // A chave canônica inclui cliente, operação e hash do rascunho. A chave
    // enviada pelo chamador não pode atravessar clientes nem furar deduplicação.
    const op = key('worki:instagram:publish', client, draft.contentHash);
    const prior = store.get(op);
    if (store.locks.has(op)) return { code: 409, body: { error: 'operation_in_progress' } };
    if (prior?.status === 'verified') return { code: 200, body: { status: 'verified', replayed: true, result: prior.result } };
    if (prior?.status === 'uncertain' || prior?.status === 'started') {
      const reconciled = await reconcileZernio({ client, draft, operation: op, prior });
      if (reconciled.kind === 'found') {
        finish(task, 'publish_instagram', op, 'verified', reconciled.result, 'zernio', reconciled.result.postId);
        return { code: 200, body: { status: 'verified', reconciled: true, result: reconciled.result } };
      }
      if (reconciled.kind !== 'absent') return { code: 409, body: { error: 'uncertain_previous_attempt', hint: 'não foi possível confirmar a publicação no Zernio' } };
    }
    const started = prior?.status === 'uncertain' || prior?.status === 'started'
      ? store.restart(op, { op: 'publish_instagram', client, draftId, contentHash: hash, provider: 'zernio', stage: 'zernio', taskId: task.id })
      : store.begin(op, { op: 'publish_instagram', client, draftId, contentHash: hash, provider: 'zernio', stage: 'zernio', taskId: task.id });
    if (started.status === 'locked') return { code: 409, body: { error: 'operation_in_progress' } };
    taskRecord(task, 'publish_instagram', op, 'started', undefined, 'zernio');
    const made = await call('zernio', 'POST', '/v1/posts', { content: draft.caption, mediaItems: draft.mediaItems, platforms: [{ platform: 'instagram', accountId: draft.accountId }], publishNow: true, metadata: { workiOperation: op, workiContentHash: hash } }, { 'Idempotency-Key': op }, { operation: op });
    if (made.kind !== 'ok') { finish(task, 'publish_instagram', op, made.kind === 'uncertain' ? 'uncertain' : 'failed', undefined, 'zernio'); return { code: made.kind === 'uncertain' ? 504 : 502, body: { error: made.kind === 'uncertain' ? 'uncertain' : 'zernio_error' } }; }
    const id = made.data?._id || made.data?.id || made.data?.post?._id || made.data?.post?.id;
    if (!id) { finish(task, 'publish_instagram', op, 'uncertain', undefined, 'zernio'); return { code: 504, body: { error: 'uncertain' } }; }
    store.update(op, { provider: 'zernio', stage: 'zernio', providerRef: id });
    const read = await call('zernio', 'GET', `/v1/posts/${encodeURIComponent(id)}`, undefined, {}, { operation: op });
    if (read.kind !== 'ok') { finish(task, 'publish_instagram', op, read.kind === 'uncertain' ? 'uncertain' : 'failed', undefined, 'zernio', id); return { code: read.kind === 'uncertain' ? 504 : 502, body: { error: read.kind === 'uncertain' ? 'uncertain' : 'zernio_error' } }; }
    const verified = verifyZernioPost(read.data, draft, id);
    if (verified.kind !== 'found') { finish(task, 'publish_instagram', op, 'uncertain', undefined, 'zernio', id); return { code: 409, body: { error: 'verification_failed' } }; }
    const result = verified.result;
    finish(task, 'publish_instagram', op, 'verified', result, 'zernio', String(id));
    return { code: 200, body: { status: 'verified', result } };
  }

  async function recover() {
    const rows = store.entries().filter((row) => ['started', 'uncertain'].includes(row.status));
    let found = 0; let unknown = 0;
    for (const row of rows) {
      if (store.locks.has(row.key)) { unknown++; continue; }
      let result = null;
      if (row.op === 'publish_instagram' && flag(env, 'WRITE_ZERNIO_ENABLED')) {
        const draft = store.get(key('draft', row.client, row.draftId))?.result;
        if (draft) result = await reconcileZernio({ client: row.client, draft, operation: row.key, prior: row });
      } else if (row.op === 'publish_page' && flag(env, 'WRITE_VERCEL_ENABLED')) {
        result = await reconcileVercel({ client: row.client, page: { digest: row.digest }, operation: row.key, prior: row });
      }
      if (result?.kind === 'found') {
        const output = row.op === 'publish_page'
          ? { ...result.result, githubRef: safe(row.githubRef, 300), digest: row.digest, target: row.target || 'preview' }
          : result.result;
        store.finish(row.key, 'verified', { result: output, reconciled: true });
        const task = tasks?.tasks?.get(row.taskId);
        if (task) {
          const op = row.op === 'publish_page' ? (row.target === 'production' ? 'deploy_vercel_production' : 'deploy_vercel_preview') : 'publish_instagram';
          taskRecord(task, op, row.key, 'verified', JSON.stringify(output), row.provider || (row.op === 'publish_page' ? 'vercel' : 'zernio'), row.providerRef);
          if (task.state !== 'revoked') tasks.setState(task.id, 'verified', op);
        }
        found++;
      } else if (result?.kind === 'unknown' || !result) unknown++;
    }
    return { scanned: rows.length, found, unknown };
  }

  return { enabled: { vercel: flag(env, 'WRITE_VERCEL_ENABLED'), zernio: flag(env, 'WRITE_ZERNIO_ENABLED'), github: flag(env, 'WRITE_GITHUB_ENABLED') }, pagePublish, instagramPrepare, instagramPublish, recover, store, close: () => store.close() };
}
