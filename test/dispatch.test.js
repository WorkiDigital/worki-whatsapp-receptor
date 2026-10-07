import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../lib/dispatch.js';
import { world, ADMIN, MARIA } from './helpers.js';

const GROUP = '120363000000000001@g.us';
const ENV = { PUBLIC_BASE_URL: 'https://r.exemplo.com/', MAX_AGE_SECONDS: '600' };
const ev = (n, conv, sender, at, payload = {}) => ({ key: `worki:${n}`, client: 'worki', conv, sender, payload: { type: 'conversation', text: 'oi', receivedAt: at, ...payload } });

function setup(fireImpl) {
  const w = world(); const fired = []; const logs = [];
  const d = createDispatcher({ env: ENV, cfg: { url: 'https://x' }, access: w.access, tasks: w.tasks, now: w.clock.now ?? (() => w.clock.t), log: (e, f) => logs.push([e, f.code]), fireImpl: fireImpl ?? (async (_c, text) => { fired.push(text); return 200; }) });
  return { w, d, fired, logs };
}

test('despacho: só quem tem acesso e recente vira tarefa; o texto leva token, remetente verificado e permissões', async () => {
  const { w, d, fired, logs } = setup();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    const t = w.clock.t;
    await d(ev(1, `${MARIA}@s.whatsapp.net`, `${MARIA}@s.whatsapp.net`, t));                       // ok
    await d(ev(2, '5585900000000@s.whatsapp.net', '5585900000000@s.whatsapp.net', t));           // sem acesso
    await d(ev(3, `${MARIA}@s.whatsapp.net`, `${MARIA}@s.whatsapp.net`, t - 700_000));            // velha
    await d(ev(4, '999@lid', '999@lid', t, { convAlt: `${MARIA}@s.whatsapp.net` }));               // @lid com alternativo verificado
    await d(ev(5, '888@lid', '888@lid', t));                                                        // @lid sem número: negado
    assert.equal(fired.length, 2);
    assert.match(fired[0], /remetente verificado: 5585988887777/); assert.match(fired[0], /token da tarefa: [0-9a-f]{48}/);
    assert.match(fired[0], /read_meta_insights/); assert.match(fired[0], /API: https:\/\/r\.exemplo\.com\b/);
    assert.deepEqual(logs.filter((l) => l[0] === 'skipped').map((l) => l[1]), ['not_allowed', 'stale', 'not_allowed']);
    assert.equal(w.tasks.stats().tasks.dispatched, 2);
  } finally { w.close(); }
});

test('despacho em grupo: grupo precisa estar registrado E o remetente individual precisa de acesso', async () => {
  const { w, d, fired, logs } = setup();
  try {
    w.access.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    const t = w.clock.t;
    await d(ev(1, GROUP, `${MARIA}@s.whatsapp.net`, t));                                            // grupo não registrado
    w.access.registerGroup({ by: ADMIN, jid: GROUP, client: 'x' });
    await d(ev(2, GROUP, '5585900000000@s.whatsapp.net', t));                                        // sem acesso individual
    await d(ev(3, GROUP, `${MARIA}@s.whatsapp.net`, t));                                             // ok
    assert.equal(fired.length, 1); assert.match(fired[0], /grupo registrado \(cliente: x\)/);
    assert.deepEqual(logs.map((l) => l[1]), ['group_not_registered', 'not_allowed', undefined]);
  } finally { w.close(); }
});

test('disparo recusado (HTTP 4xx/5xx) repete com novo token e sem duplicar tarefa; aceito não repete', async () => {
  let status = 500; const fired = [];
  const { w, d } = setup(async (_c, text) => { fired.push(text); return status; });
  try {
    const e = ev(1, `${ADMIN}@s.whatsapp.net`, `${ADMIN}@s.whatsapp.net`, w.clock.t);
    await assert.rejects(d(e), /destino recusou/);
    status = 200; await d(e);
    assert.equal(w.tasks.tasks.size, 1); assert.equal(fired.length, 2);
    const tok = (s) => /token da tarefa: (\S+)/.exec(s)[1];
    assert.notEqual(tok(fired[0]), tok(fired[1])); assert.equal(w.tasks.authenticate(tok(fired[0])), null, 'token antigo não vale');
    assert.ok(w.tasks.authenticate(tok(fired[1])));
    await d(e); assert.equal(fired.length, 2, 'já disparado: não dispara de novo');
  } finally { w.close(); }
});

test('disparo sem resposta (timeout) fica incerto e NÃO é repetido', async () => {
  let n = 0;
  const { w, d } = setup(async () => { n++; throw new Error('timeout'); });
  try {
    const e = ev(1, `${ADMIN}@s.whatsapp.net`, `${ADMIN}@s.whatsapp.net`, w.clock.t);
    await d(e); await d(e);
    assert.equal(n, 1);
    assert.equal([...w.tasks.tasks.values()][0].state, 'dispatch_uncertain');
  } finally { w.close(); }
});

test('reinício: tarefas, estados, operações e tokens persistem; stats contam tarefas paradas', async () => {
  const { TaskStore } = await import('../lib/tasks.js');
  const w = world();
  try {
    const a = w.task({ sender: ADMIN });
    w.tasks.recordOp({ taskId: a.t.id, key: 'k', op: 'create_whatsapp_group', status: 'verified', evidence: '{"ok":1}' });
    w.tasks.setState(a.t.id, 'verified');
    const r = new TaskStore({ dir: w.dir, now: () => w.clock.t });
    assert.equal(r.authenticate(a.token).id, a.t.id); assert.equal(r.tasks.get(a.t.id).state, 'verified');
    assert.equal(r.getOp(a.t.id, 'k').status, 'verified');
    w.clock.t += 31 * 60_000; assert.equal(r.stats().stalled, 1);
    w.clock.t += 3 * 3600_000; assert.equal(r.authenticate(a.token), null, 'token expira');
    r.close();
  } finally { w.close(); }
});
