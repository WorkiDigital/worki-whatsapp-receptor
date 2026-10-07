import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessStore } from '../lib/access.js';
import { TaskStore } from '../lib/tasks.js';
import { createApi } from '../lib/api.js';

export const ADMIN = '5585900010001';
export const MARIA = '5585988887777';
export const ENV = { SEND_SECRET: 'segredo-rotina', ADMIN_SENDERS: ADMIN, REPLY_ENABLED: 'true' };

// Evolution simulada: cada chamada registra e responde conforme o roteiro (`script[nome]` = fn ou resposta fixa).
export function fakeEvo(script = {}) {
  const calls = [];
  const mk = (name, dflt) => async (arg) => { calls.push({ name, arg }); const s = script[name]; return typeof s === 'function' ? s(arg, calls) : (s ?? dflt); };
  return {
    calls,
    sendText: mk('sendText', { kind: 'ok', http: 201, data: { key: { id: 'MSG1' } } }),
    createGroup: mk('createGroup', { kind: 'ok', http: 201, data: { id: '120363000000000001@g.us', subject: 'x', participants: [] } }),
    sendPoll: mk('sendPoll', { kind: 'ok', http: 201, data: { key: { id: 'POLL1' } } }),
    sendReaction: mk('sendReaction', { kind: 'ok', http: 201, data: { key: { id: 'REACT1' } } }),
    findGroupInfos: mk('findGroupInfos', { kind: 'ok', http: 200, data: null }),
    fetchAllGroups: mk('fetchAllGroups', { kind: 'ok', http: 200, data: [] }),
  };
}

export function world({ evo = fakeEvo(), env = {}, t0 = 1_800_000_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rcv-'));
  const clock = { t: t0 };
  const now = () => clock.t;
  const access = new AccessStore({ dir, admins: [ADMIN], now });
  const tasks = new TaskStore({ dir, now });
  const api = createApi({ env: { ...ENV, ...env }, access, tasks, evo, now });
  // Cria uma tarefa como o despachante faria (identidade verificada pelo webhook, não pelo modelo).
  const task = ({ sender = ADMIN, conv, isGroup = false, client = null, msgId = 'M1', n = Math.random() } = {}) => {
    const { task: t, token } = tasks.issue({ eventKey: `worki:${n}`, sender, conv: conv ?? `${sender}@s.whatsapp.net`, isGroup, client, msgId, request: 'pedido' });
    tasks.setState(t.id, 'dispatched');
    return { t, token };
  };
  const call = (path, token, body, { secret = ENV.SEND_SECRET, method = 'POST' } = {}) => new Promise((resolve) => {
    const res = { status(c) { this.c = c; return this; }, json(o) { resolve({ code: this.c, body: o }); } };
    api({ method, headers: { ...(secret ? { 'x-send-secret': secret } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body }, res, path);
  });
  return { dir, clock, access, tasks, evo, api, task, call, close() { access.close(); tasks.close(); rmSync(dir, { recursive: true, force: true }); } };
}
