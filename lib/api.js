import { createHash } from 'node:crypto';
import { validAny, secretsOf } from './security.js';
import { AccessError } from './access.js';
import { OPERATIONS, ADMIN_OPERATION, WRITE_MEDIATED } from './catalog.js';
import { remember } from './history.js';
import { digits, numberOf, variants } from './numbers.js';

// API usada pela rotina (executor). Toda chamada exige:
//   X-Send-Secret  (segredo da rotina)  +  Authorization: Bearer <token da tarefa> (emitido pelo receptor a cada pedido).
// O remetente vem do token (webhook verificado), nunca do corpo. Permissões são conferidas AQUI, a cada chamada.
// Logs sem texto, números, JIDs ou segredos.
const log = (event, f = {}) => console.log(JSON.stringify({ event, ...f }));
const bearer = (h) => /^Bearer (\S+)$/.exec(String(h || ''))?.[1] ?? null;
const keyOf = (...p) => createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
const errStatus = { forbidden: 403, unknown_person: 404, unknown_group: 404, unknown_grant: 404 };

export function createLimiter({ perMinute = 5, perDay = 50, now = Date.now } = {}) {
  const hits = [];
  return {
    take() {
      const t = now();
      while (hits.length && t - hits[0] > 86_400_000) hits.shift();
      if (hits.length >= perDay) return 'daily_limit';
      if (hits.filter((h) => t - h <= 60_000).length >= perMinute) return 'minute_limit';
      hits.push(t);
      return null;
    },
  };
}

export function createApi({ env = process.env, access, tasks, evo, history, mediated, now = Date.now, limiter = createLimiter({ perMinute: Number(env.REPLY_PER_MINUTE || 5), perDay: Number(env.REPLY_PER_DAY || 50), now }) } = {}) {
  const maxChars = Number(env.REPLY_MAX_CHARS || 3000);
  const maxReplies = Number(env.TASK_MAX_REPLIES || 12);

  // ---- autenticação e revalidação ----
  const auth = (req) => {
    if (!secretsOf(env, 'SEND_SECRET').length) return { code: 503, body: { error: 'not_configured' } };
    if (!validAny(env, 'SEND_SECRET', req.headers['x-send-secret'])) return { code: 401, body: { error: 'unauthorized' } };
    const task = tasks.authenticate(bearer(req.headers.authorization));
    if (!task) return { code: 401, body: { error: 'invalid_task' } };
    // Revalida a cada chamada: acesso revogado/expirado/suspenso (ou grupo removido) vale até para tarefas já na fila.
    if (!access.hasAccess(task.sender) || (task.isGroup && !access.group(task.conv))) {
      if (task.state !== 'revoked') tasks.setState(task.id, 'revoked', 'acesso_revogado');
      log('task_revoked', { task: task.id });
      return { code: 403, body: { error: 'access_revoked' } };
    }
    return { task };
  };

  // Cliente efetivo: em grupo, o do registro do grupo; em conversa privada, o informado (ou o único possível).
  const clientOf = (task, asked) => {
    if (task.isGroup) {
      const g = access.group(task.conv);
      if (asked && asked !== g.client) return { error: 'client_mismatch' };
      return { client: g.client };
    }
    if (asked) return { client: String(asked) };
    const cs = access.clientsFor(task.sender);
    if (cs !== '*' && cs.length === 1) return { client: cs[0] };
    return { error: 'client_required' };
  };

  const guard = (task, op, asked) => {
    const c = clientOf(task, asked);
    if (c.error) return { code: 422, body: { error: c.error } };
    const can = access.can(task.sender, op, c.client);
    if (!can.ok) { log('op_denied', { task: task.id, op, reason: can.reason }); return { code: 403, body: { error: 'forbidden', op, client: c.client, reason: can.reason } }; }
    return { client: c.client };
  };

  const target = (task, to) => {
    if (!to || to === task.conv || digits(to) === task.sender) return task.isGroup ? task.conv : task.sender;
    const g = access.group(String(to));
    if (g && access.can(task.sender, 'send_whatsapp_group', g.client).ok) return g.jid;
    return null;
  };

  // ---- operação externa idempotente, com verificação e reconciliação ----
  async function runOp(task, { op, key, exec, verify, reconcile }) {
    const prev = tasks.getOp(task.id, key);
    if (prev && (prev.status === 'done' || prev.status === 'verified')) return { code: 200, body: { status: prev.status, replayed: true, result: safeParse(prev.evidence) } };
    if (prev && (prev.status === 'started' || prev.status === 'uncertain')) {
      if (!reconcile) return { code: 409, body: { error: 'uncertain_previous_attempt', hint: 'resultado anterior incerto; não repetido. Confirme com o usuário ou verifique manualmente.' } };
      const r = await reconcile(prev);
      if (r.kind === 'found') {
        tasks.recordOp({ taskId: task.id, key, op, status: 'verified', evidence: JSON.stringify(r.result), platform: 'evolution' });
        tasks.setState(task.id, 'verified', op);
        return { code: 200, body: { status: 'verified', reconciled: true, result: r.result } };
      }
      if (r.kind !== 'absent') return { code: 409, body: { error: 'uncertain_previous_attempt', hint: 'não foi possível confirmar se a tentativa anterior ocorreu.' } };
    }
    tasks.recordOp({ taskId: task.id, key, op, status: 'started', platform: 'evolution' });
    if (['persisted', 'dispatched'].includes(task.state)) tasks.setState(task.id, 'started', op);
    const res = await exec();
    if (res.kind === 'uncertain') {
      tasks.recordOp({ taskId: task.id, key, op, status: 'uncertain', platform: 'evolution' });
      tasks.setState(task.id, 'uncertain', op);
      log('op_uncertain', { task: task.id, op });
      return { code: 504, body: { error: 'uncertain', hint: 'sem resposta do serviço; a operação pode ter ocorrido. Não repita às cegas: chame de novo com a mesma chave para reconciliar.' } };
    }
    if (res.kind === 'rejected') {
      tasks.recordOp({ taskId: task.id, key, op, status: 'failed', evidence: `http ${res.http}`, platform: 'evolution' });
      log('op_failed', { task: task.id, op, http: res.http });
      return { code: 502, body: { error: 'service_rejected', http: res.http } };
    }
    tasks.setState(task.id, 'external_done', op);
    const v = await verify(res.data);
    tasks.recordOp({ taskId: task.id, key, op, status: v.verified ? 'verified' : 'done', evidence: JSON.stringify(v.result), platform: 'evolution' });
    if (v.verified) tasks.setState(task.id, 'verified', op);
    log('op_done', { task: task.id, op, verified: v.verified });
    return { code: 200, body: { status: v.verified ? 'verified' : 'done', result: v.result } };
  }
  const safeParse = (s) => { try { return JSON.parse(s); } catch { return s ?? null; } };

  const msgKeyOf = (data) => data?.key?.id ?? null;

  // ---- handlers ----
  const h = {};

  h['/api/task/reply'] = async (task, body) => {
    if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > maxChars) return { code: 422, body: { error: 'invalid_text' } };
    if (task.replies >= maxReplies) return { code: 429, body: { error: 'task_reply_limit' } };
    const lim = limiter.take();
    if (lim) return { code: 429, body: { error: lim } };
    const final = body.final !== false;
    const to = task.isGroup ? task.conv : task.sender;
    const r = await evo.sendText({ number: to, text: body.text });
    if (r.kind === 'ok') { if (env.HISTORY_ENABLED === 'true') remember(history, { conv: task.conv, role: 'assistant', text: body.text }); tasks.setState(task.id, final ? 'replied' : task.state, final ? 'reply' : undefined); log('sent', { task: task.id }); return { code: 200, body: { status: 'sent' } }; }
    if (r.kind === 'uncertain') { log('send_uncertain', { task: task.id }); return { code: 502, body: { error: 'send_uncertain', hint: 'envio sem resposta; pode ter sido entregue. Não reenvie sem verificar.' } }; }
    log('send_failed', { task: task.id, http: r.http });
    return { code: 502, body: { error: 'evolution_error', http: r.http } };
  };

  // Encaminhamento humano REAL: avisa o atualizador (OPERATOR_CONTACT) por WhatsApp e registra o estado. Sem contato configurado,
  // devolve erro: a rotina NÃO pode prometer que um humano vai continuar.
  h['/api/ops/handoff'] = async (task, body) => {
    const reason = String(body?.reason ?? '').trim().slice(0, 400);
    if (!reason) return { code: 422, body: { error: 'reason_required' } };
    const to = digits(env.OPERATOR_CONTACT);
    if (to.length < 10) return { code: 503, body: { error: 'handoff_not_configured', hint: 'OPERATOR_CONTACT ausente: não prometa encaminhamento.' } };
    if (task.state === 'handoff') return { code: 200, body: { status: 'handoff', replayed: true } };
    const lim = limiter.take();
    if (lim) return { code: 429, body: { error: lim } };
    const where = task.isGroup ? `grupo (cliente ${access.group(task.conv)?.client})` : 'conversa privada';
    const r = await evo.sendText({ number: to, text: `Encaminhamento humano (tarefa ${task.id})\nde: ${task.sender}\nem: ${where}\npedido: ${task.request}\nmotivo: ${reason}` });
    if (r.kind !== 'ok') { log('handoff_failed', { task: task.id, code: r.kind }); return { code: 502, body: { error: r.kind === 'uncertain' ? 'handoff_uncertain' : 'handoff_failed' } }; }
    tasks.setState(task.id, 'handoff', 'humano_avisado');
    log('handoff', { task: task.id });
    return { code: 200, body: { status: 'handoff' } };
  };

  h['/api/ops/can'] = async (task, body) => {
    if (!OPERATIONS.includes(body?.op)) return { code: 422, body: { error: 'invalid_op' } };
    const c = clientOf(task, body.client);
    if (c.error) return { code: 422, body: { error: c.error } };
    const can = access.can(task.sender, body.op, c.client);
    return { code: 200, body: { allowed: can.ok, op: body.op, client: c.client, reason: can.reason ?? null } };
  };

  h['/api/ops/me'] = async (task) => ({ code: 200, body: { access: access.view(task.sender), clients: access.clientsFor(task.sender), conversation: task.isGroup ? 'group' : 'private', client: task.isGroup ? access.group(task.conv).client : null } });

  h['/api/ops/history'] = async (task, body) => {
    const admin = access.isAdmin(task.sender);
    return { code: 200, body: { tasks: tasks.history({ sender: admin ? undefined : task.sender, client: body?.client, limit: body?.limit }) } };
  };

  // Registro de operações feitas em OUTRAS plataformas (Zernio, GitHub, Vercel): o executor consulta `can`, executa,
  // grava a evidência aqui e só então responde. O receptor não vê essas credenciais: a barreira nelas é `can` + este registro.
  h['/api/ops/record'] = async (task, body) => {
    if (!OPERATIONS.includes(body?.op)) return { code: 422, body: { error: 'invalid_op' } };
    if (!['started', 'done', 'verified', 'failed', 'uncertain'].includes(body.status)) return { code: 422, body: { error: 'invalid_status' } };
    if (['done', 'verified'].includes(body.status) && (typeof body.evidence !== 'string' || body.evidence.trim().length < 3)) return { code: 422, body: { error: 'evidence_required' } };
    const g = guard(task, body.op, body.client);
    if (g.code) return g;
    // Escrita externa: o receptor não pode comprovar o que o executor fez com credenciais próprias, então não certifica.
    if (WRITE_MEDIATED.includes(body.op) && ['done', 'verified'].includes(body.status)) {
      log('record_refused', { task: task.id, op: body.op });
      return { code: 409, body: { error: 'mediated_only', hint: 'sucesso de operação de escrita externa só é certificado por rota que o próprio receptor executa e relê; registre started/failed/uncertain ou relate o bloqueio.' } };
    }
    const key = String(body.idempotencyKey || keyOf(body.op, body.ref ?? '', g.client)).slice(0, 64);
    const prev = tasks.getOp(task.id, key);
    if (prev?.status === 'verified' && body.status !== 'verified') return { code: 409, body: { error: 'already_verified', previous: prev.status } };
    tasks.recordOp({ taskId: task.id, key, op: body.op, status: body.status, evidence: body.evidence, platform: String(body.platform || '').slice(0, 40), ref: body.ref });
    const next = { started: 'started', done: 'external_done', verified: 'verified', failed: 'failed', uncertain: 'uncertain' }[body.status];
    tasks.setState(task.id, next, body.op);
    return { code: 200, body: { recorded: true, key, previous: prev?.status ?? null } };
  };

  h['/api/ops/whatsapp/create-group'] = async (task, body) => {
    const g = guard(task, 'create_whatsapp_group', body?.client);
    if (g.code) return g;
    const subject = String(body?.subject ?? '').trim();
    if (!subject || subject.length > 100) return { code: 422, body: { error: 'invalid_subject' } };
    let parts = Array.isArray(body.participants) ? body.participants.map(digits) : [];
    if (body.includeRequester === true && !task.isGroup) parts.push(task.sender);
    parts = [...new Set(parts)];
    if (!parts.length || parts.some((p) => p.length < 10 || p.length > 15)) return { code: 422, body: { error: 'invalid_participants' } };
    const description = body.description ? String(body.description).slice(0, 500) : undefined;
    const key = String(body.idempotencyKey || keyOf('group', subject, [...parts].sort())).slice(0, 64);
    const present = (found, n) => [...variants(n)].some((v) => found.has(v));
    const same = (x) => String(x ?? '').trim().toLowerCase() === subject.toLowerCase();
    // Evolution pode devolver o identificador privado @lid junto do telefone resolvido
    // em `phoneNumber`. Nunca transforme os dígitos do @lid em telefone.
    const participantNumber = (p) => {
      const id = String(p?.id ?? p?.jid ?? '');
      const phone = [p?.phoneNumber, p?.phone, p?.number, p?.pn, p?.phoneNumberAlt]
        .map(numberOf).find(Boolean) || '';
      return id.endsWith('@lid') ? phone : (numberOf(id) || phone);
    };
    // Participantes: pedidos x encontrados. `unexpected` = quem está no grupo e não foi pedido (a conta que cria o grupo,
    // o dono, não conta). Em teste que pede "somente meu contato", o esperado é unexpected = [].
    const summarize = (info, id) => {
      const list = info?.participants ?? [];
      const requested = new Set(parts.flatMap((x) => [...variants(x)]));
      const ownerJid = String(info?.owner ?? info?.ownerJid ?? '').trim();
      const owner = numberOf(info?.ownerPn ?? info?.owner ?? '');
      const isOwner = (p, n) => {
        const pid = String(p?.id ?? p?.jid ?? '').trim();
        if (owner && n && present(new Set(variants(owner)), n)) return true;
        if (ownerJid && pid === ownerJid) return true;
        // Quando owner é um @lid sem ownerPn, o superadmin é a única indicação
        // verificável de que o participante é a conta criadora.
        return !owner && p?.admin === 'superadmin';
      };
      const found = new Set(list.flatMap((p) => [...variants(participantNumber(p))]));
      const unexpected = list.map((p) => participantNumber(p)).filter((n, i) => n && !present(requested, n) && !isOwner(list[i], n));
      return { groupJid: id, subject: info?.subject ?? subject, requested: parts.length, found: parts.filter((n) => present(found, n)).length, missing: parts.filter((n) => !present(found, n)), unexpected, members: list.length };
    };
    // PRÉ-VERIFICAÇÃO: antes de qualquer criação, procura grupo com o mesmo nome. Se já existe, NÃO cria (a menos que
    // allowDuplicate=true); se não for possível listar, NÃO cria (falha fechada).
    if (body.allowDuplicate !== true && !tasks.getOp(task.id, key)) {
      const all = await evo.fetchAllGroups();
      if (all.kind !== 'ok' || !Array.isArray(all.data)) { log('preflight_failed', { task: task.id }); return { code: 503, body: { error: 'preflight_failed', hint: 'não foi possível listar grupos; nada foi criado.' } }; }
      const hit = all.data.find((x) => same(x.subject));
      if (hit) {
        const result = summarize(hit, hit.id);
        tasks.recordOp({ taskId: task.id, key, op: 'create_whatsapp_group', status: 'verified', evidence: JSON.stringify({ ...result, existed: true }), platform: 'evolution' });
        tasks.setState(task.id, 'verified', 'group_exists');
        return { code: 200, body: { status: 'exists', created: false, result } };
      }
    }
    const out = await runOp(task, {
      op: 'create_whatsapp_group', key,
      exec: () => evo.createGroup({ subject, participants: parts, description }),
      verify: async (data) => {
        const id = data?.id ?? data?.groupJid;
        if (!id) return { verified: false, result: { note: 'resposta sem id do grupo' } };
        const info = await evo.findGroupInfos(id);
        const meta = info.kind === 'ok' ? info.data : null;
        const result = summarize(meta ?? data, id);
        return { verified: Boolean(meta && meta.subject === subject), result };
      },
      // Após timeout: procura o grupo antes de repetir (nome igual e criado após a tentativa).
      reconcile: async (prev) => {
        const all = await evo.fetchAllGroups();
        if (all.kind !== 'ok' || !Array.isArray(all.data)) return { kind: 'unknown' };
        const hit = all.data.find((x) => same(x.subject) && (Number(x.creation) || 0) * 1000 >= prev.at - 120_000);
        return hit ? { kind: 'found', result: summarize(hit, hit.id) } : { kind: 'absent' };
      },
    });
    if (out.code === 200 && body.register === true && out.body.result?.groupJid) {
      try { access.registerGroup({ by: task.sender, jid: out.body.result.groupJid, client: g.client, name: subject }); out.body.registered = true; }
      catch { out.body.registered = false; out.body.registerNote = 'sem manage_access: grupo criado, mas não registrado para atendimento'; }
    }
    return out;
  };

  h['/api/ops/whatsapp/poll'] = async (task, body) => {
    const g = guard(task, 'send_whatsapp_poll', body?.client);
    if (g.code) return g;
    const name = String(body?.name ?? '').trim();
    const values = body?.values;
    const sel = body?.selectableCount ?? 1;
    if (!name || name.length > 255) return { code: 422, body: { error: 'invalid_name' } };
    if (!Array.isArray(values) || values.length < 2 || values.length > 10 || new Set(values).size !== values.length || values.some((v) => typeof v !== 'string' || !v.trim())) return { code: 422, body: { error: 'invalid_values' } };
    if (!Number.isInteger(sel) || sel < 0 || sel > 10) return { code: 422, body: { error: 'invalid_selectable_count' } };
    const to = target(task, body.to);
    if (!to) return { code: 403, body: { error: 'target_not_allowed' } };
    return runOp(task, {
      op: 'send_whatsapp_poll', key: String(body.idempotencyKey || keyOf('poll', to, name, values)).slice(0, 64),
      exec: () => evo.sendPoll({ number: to, name, values, selectableCount: sel }),
      verify: async (data) => ({ verified: Boolean(msgKeyOf(data)), result: { messageId: msgKeyOf(data) } }),
    });
  };

  h['/api/ops/whatsapp/react'] = async (task, body) => {
    const g = guard(task, 'react_whatsapp_message', body?.client);
    if (g.code) return g;
    const messageId = String(body?.messageId || task.msgId || '');
    const reaction = body?.reaction;
    if (!messageId) return { code: 422, body: { error: 'messageId_required' } };
    if (typeof reaction !== 'string' || reaction.length > 16) return { code: 422, body: { error: 'invalid_reaction' } };
    // A mensagem alvo é da conversa da tarefa (o receptor só conhece o id dessa conversa).
    return runOp(task, {
      op: 'react_whatsapp_message', key: String(body.idempotencyKey || keyOf('react', task.conv, messageId, reaction)).slice(0, 64),
      exec: () => evo.sendReaction({ remoteJid: task.conv, messageId, fromMe: false, reaction }),
      verify: async (data) => ({ verified: Boolean(msgKeyOf(data)), result: { messageId: msgKeyOf(data) } }),
    });
  };

  h['/api/ops/whatsapp/ghost-mention'] = async (task, body) => {
    const g = guard(task, 'mention_whatsapp_ghost', body?.client);
    if (g.code) return g;
    const text = String(body?.text ?? '');
    if (!text.trim() || text.length > maxChars) return { code: 422, body: { error: 'invalid_text' } };
    const everyone = body.everyone === true;
    const mentioned = Array.isArray(body.mentioned) ? [...new Set(body.mentioned.map(digits))] : [];
    if (!everyone && !mentioned.length) return { code: 422, body: { error: 'mention_target_required' } };
    if (mentioned.some((n) => n.length < 10 || n.length > 15)) return { code: 422, body: { error: 'invalid_mentioned' } };
    const to = target(task, body.to);
    if (!to) return { code: 403, body: { error: 'target_not_allowed' } };
    if (everyone && !to.endsWith('@g.us')) return { code: 422, body: { error: 'everyone_only_in_group' } };
    return runOp(task, {
      op: 'mention_whatsapp_ghost', key: String(body.idempotencyKey || keyOf('ghost', to, text, everyone, mentioned)).slice(0, 64),
      exec: () => evo.sendText({ number: to, text, mentionsEveryOne: everyone, mentioned: everyone ? undefined : mentioned }),
      verify: async (data) => ({ verified: Boolean(msgKeyOf(data)), result: { messageId: msgKeyOf(data), everyone, mentioned: mentioned.length } }),
    });
  };

  // Escritas mediadas: o alvo vem do vínculo privado por cliente e as credenciais ficam no receptor.
  // As funções continuam registradas mesmo desligadas para que a rotina receba um erro explícito e possa fazer handoff.
  h['/api/ops/page/publish'] = async (task, body) => {
    const c = clientOf(task, body?.client);
    if (c.error) return { code: 422, body: { error: c.error } };
    if (!mediated) return { code: 503, body: { error: 'mediated_not_configured' } };
    return mediated.pagePublish({ task, client: c.client, body });
  };

  h['/api/ops/instagram/prepare'] = async (task, body) => {
    const c = clientOf(task, body?.client);
    if (c.error) return { code: 422, body: { error: c.error } };
    if (!mediated) return { code: 503, body: { error: 'mediated_not_configured' } };
    return mediated.instagramPrepare({ task, client: c.client, body });
  };

  h['/api/ops/instagram/publish'] = async (task, body) => {
    const c = clientOf(task, body?.client);
    if (c.error) return { code: 422, body: { error: c.error } };
    if (!mediated) return { code: 503, body: { error: 'mediated_not_configured' } };
    return mediated.instagramPublish({ task, client: c.client, body });
  };

  // ---- administração (só conversa privada; remetente vem do token) ----
  const adminGate = (task) => {
    if (task.isGroup) return { code: 403, body: { error: 'admin_only_private' } };
    if (access.isAdmin(task.sender)) return null;
    const cs = access.clientsFor(task.sender);
    const manages = Array.isArray(cs) && cs.some((c) => access.can(task.sender, ADMIN_OPERATION, c).ok);
    return manages ? null : { code: 403, body: { error: 'forbidden', reason: 'no_manage_access' } };
  };

  h['/api/admin/access'] = async (task, body) => {
    const deny = adminGate(task);
    if (deny) { log('admin_denied', { task: task.id }); return deny; }
    const by = task.sender;
    const a = body?.action;
    try {
      let view;
      if (a === 'grant') view = access.grant({ by, number: body.number, name: body.name, clients: body.clients, ops: body.ops, expiresAt: body.expiresAt ?? null, note: body.note ?? null, mode: body.mode === 'set' ? 'set' : 'add' });
      else if (a === 'suspend') view = access.setStatus({ by, number: body.number, status: 'suspended' });
      else if (a === 'reactivate') view = access.setStatus({ by, number: body.number, status: 'active' });
      else if (a === 'revoke') view = access.setStatus({ by, number: body.number, status: 'revoked' });
      else if (a === 'revoke_grant') view = access.revokeGrant({ by, number: body.number, grantId: body.grantId });
      else if (a === 'get') { view = access.view(body.number); if (!view) return { code: 404, body: { error: 'unknown_person' } }; }
      else if (a === 'list') return { code: 200, body: { people: access.isAdmin(by) ? access.list() : access.list().filter((p) => p.grants.some((g) => g.clients.some((c) => access.can(by, ADMIN_OPERATION, c).ok))) } };
      else return { code: 422, body: { error: 'invalid_action' } };
      if (a !== 'get') log('access_changed', { task: task.id, action: a });
      return { code: 200, body: { done: true, access: view } }; // `view` = leitura do que ficou registrado
    } catch (e) {
      if (e instanceof AccessError) return { code: errStatus[e.code] ?? 422, body: { error: e.code, message: e.message } };
      throw e;
    }
  };

  h['/api/admin/groups'] = async (task, body) => {
    const deny = adminGate(task);
    if (deny) return deny;
    const by = task.sender;
    try {
      if (body?.action === 'register') return { code: 200, body: { group: redact(access.registerGroup({ by, jid: body.jid, client: body.client, name: body.name })) } };
      if (body?.action === 'remove') return { code: 200, body: { group: redact(access.removeGroup({ by, jid: body.jid })) } };
      if (body?.action === 'list') return { code: 200, body: { groups: access.listGroups().filter((g) => access.isAdmin(by) || access.can(by, ADMIN_OPERATION, g.client).ok).map(redact) } };
      return { code: 422, body: { error: 'invalid_action' } };
    } catch (e) {
      if (e instanceof AccessError) return { code: errStatus[e.code] ?? 422, body: { error: e.code, message: e.message } };
      throw e;
    }
  };
  const redact = (g) => ({ jid: g.jid, client: g.client, name: g.name, status: g.status });

  h['/api/admin/tasks'] = async (task, body) => {
    if (!access.isAdmin(task.sender) || task.isGroup) return { code: 403, body: { error: 'forbidden' } };
    const list = tasks.history({ client: body?.client, limit: body?.limit ?? 20 }).filter((t) => !body?.state || t.state === body.state);
    return { code: 200, body: { stats: tasks.stats(), tasks: list } };
  };

  const handle = async function handle(req, res, pathname) {
    const out = (c, o) => res.status(c).json(o);
    const fn = h[pathname];
    if (!fn) return out(404, { error: 'not_found' });
    if (req.method !== 'POST') return out(405, { error: 'method_not_allowed' });
    const a = auth(req);
    if (a.code) { log('api_rejected', { path: pathname, code: a.body.error }); return out(a.code, a.body); }
    try {
      const r = await fn(a.task, req.body ?? {});
      return out(r.code, r.body);
    } catch (e) {
      if (e?.code === 'no_evolution') { log('api_error', { path: pathname, code: 'no_evolution' }); return out(503, { error: 'evolution_not_configured' }); }
      log('api_error', { path: pathname, code: e?.code || 'error' });
      return out(500, { error: 'internal_error' });
    }
  };
  handle.routes = Object.keys(h);
  return handle;
}
