import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Alerts } from '../lib/alerts.js';
import { createDispatcher } from '../lib/dispatch.js';
import { world, ADMIN } from './helpers.js';
const UNKNOWN = '5585988882222';
const GROUP = '120363000000000001@g.us';

test('alerta: desligado não grava/não envia; dedup 24h e limite global sobrevivem reinício; nunca texto por padrão', async () => {
  const w = world(); const logs = []; let a;
  const env = { UNKNOWN_ALERT_ENABLED: 'true', GROUP_ALERT_ENABLED: 'true', OPERATOR_CONTACT: ADMIN, ALERT_PER_HOUR: '2' };
  const opts = { dir: w.dir, now: () => w.clock.t, log: (e, f) => logs.push([e, f]) };
  try {
    a = new Alerts(opts); await a.notify({ number: UNKNOWN, evo: w.evo }); assert.equal(w.evo.calls.length, 0);
    assert.equal(existsSync(join(w.dir, 'alerts.jsonl')), false); a.close();
    a = new Alerts({ ...opts, env });
    await a.notify({ number: UNKNOWN, text: 'segredo privado', evo: w.evo });
    assert.equal(w.evo.calls[0].arg.number, ADMIN); assert.ok(!w.evo.calls[0].arg.text.includes('segredo privado'));
    await a.notify({ number: '558588882222', evo: w.evo }); assert.equal(w.evo.calls.length, 1);
    a.close(); a = new Alerts({ ...opts, env });
    await a.notify({ number: UNKNOWN, evo: w.evo }); assert.equal(w.evo.calls.length, 1);
    await a.notify({ group: GROUP, text: 'segredo privado', evo: w.evo }); assert.equal(w.evo.calls.length, 2);
    await a.notify({ number: '5585988883333', evo: w.evo }); assert.equal(w.evo.calls.length, 2);
    a.close(); a = new Alerts({ ...opts, env });
    await a.notify({ number: '5585988883333', evo: w.evo }); assert.equal(w.evo.calls.length, 2);
    w.clock.t += 3600_001; await a.notify({ number: UNKNOWN, evo: w.evo }); assert.equal(w.evo.calls.length, 2);
    await a.notify({ number: '5585988883333', evo: w.evo }); assert.equal(w.evo.calls.length, 3);
    w.clock.t += 86400_000; await a.notify({ number: UNKNOWN, evo: w.evo }); assert.equal(w.evo.calls.length, 4);
    assert.equal(statSync(join(w.dir, 'alerts.jsonl')).mode & 0o777, 0o600);
    for (const s of [UNKNOWN, ADMIN, GROUP, 'segredo privado']) assert.ok(!JSON.stringify(logs).includes(s));
  } finally { a?.close(); w.close(); }
});

test('alerta: texto só com opt-in; falha/timeout reservado não repete após reinício; sem operador não envia', async () => {
  const w = world(); let a;
  const env = { UNKNOWN_ALERT_ENABLED: 'true', OPERATOR_CONTACT: ADMIN, ALERT_INCLUDE_TEXT: 'true' };
  try {
    a = new Alerts({ dir: w.dir, env, now: () => w.clock.t });
    await a.notify({ number: UNKNOWN, text: 'conteudo'.repeat(100), evo: w.evo });
    assert.match(w.evo.calls[0].arg.text, /Mensagem \(conteúdo não confiável\):/);
    let attempts = 0; const evo = { sendText: async () => { attempts++; throw new Error('private-secret'); } };
    await a.notify({ number: '5585988883333', evo }); a.close();
    a = new Alerts({ dir: w.dir, env, now: () => w.clock.t }); await a.notify({ number: '5585988883333', evo }); assert.equal(attempts, 1);
    a.close(); a = new Alerts({ dir: w.dir, env: { ...env, OPERATOR_CONTACT: '' } });
    await a.notify({ number: UNKNOWN, evo }); assert.equal(attempts, 1);
  } finally { a?.close(); w.close(); }
});

test('alerta: dispatch exige flag; só privado sem acesso/grupo não registrado; nunca aciona rotina nem responde ao desconhecido', async () => {
  const w = world(); const notices = []; let fires = 0;
  const alerts = { notify: async (r) => notices.push(r) };
  const base = { PUBLIC_BASE_URL: 'https://example.com' };
  const d = (env) => createDispatcher({ env, cfg: {}, access: w.access, tasks: w.tasks, alerts, evo: w.evo, now: () => w.clock.t, fireImpl: async () => { fires++; return 200; } });
  let id = 0;
  const event = (conv) => ({ key: `worki:${++id}`, conv, sender: `${UNKNOWN}@s.whatsapp.net`, client: 'worki', payload: { text: 'privado', receivedAt: w.clock.t } });
  try {
    await d(base)(event(`${UNKNOWN}@s.whatsapp.net`)); assert.equal(notices.length, 0);
    await d({ ...base, UNKNOWN_ALERT_ENABLED: 'true' })(event(`${UNKNOWN}@s.whatsapp.net`)); assert.equal(notices.length, 1);
    await d({ ...base, UNKNOWN_ALERT_ENABLED: 'true' })(event(GROUP)); assert.equal(notices.length, 1);
    await d({ ...base, GROUP_ALERT_ENABLED: 'true' })(event(GROUP)); assert.equal(notices.length, 2); assert.equal(notices[1].text, undefined);
    w.access.registerGroup({ by: ADMIN, jid: GROUP, client: 'worki' });
    await d({ ...base, UNKNOWN_ALERT_ENABLED: 'true' })(event(GROUP)); assert.equal(notices.length, 2);
    assert.equal(fires, 0); assert.equal(w.evo.calls.length, 0);
  } finally { w.close(); }
});

test('alertas de grupo têm controle independente; reserva antecede envio lento sem bloquear próximo despacho', async () => {
  const w = world(); let a; let finish; let fires = 0;
  const env = { PUBLIC_BASE_URL: 'https://example.com', UNKNOWN_ALERT_ENABLED: 'true', OPERATOR_CONTACT: ADMIN };
  const event = (id, sender) => ({ key: `worki:${id}`, conv: `${sender}@s.whatsapp.net`, sender: `${sender}@s.whatsapp.net`, client: 'worki', payload: { text: 'private', receivedAt: w.clock.t } });
  try {
    a = new Alerts({ dir: w.dir, env, now: () => w.clock.t });
    await a.notify({ group: GROUP, evo: w.evo }); assert.equal(w.evo.calls.length, 0);
    const evo = { sendText: () => { assert.equal(a.rows.length, 1); return new Promise((r) => { finish = r; }); } };
    const d = createDispatcher({ env, cfg: {}, access: w.access, tasks: w.tasks, alerts: a, evo, now: () => w.clock.t, fireImpl: async () => { fires++; return 200; } });
    const completed = await Promise.race([d(event(1, UNKNOWN)).then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);
    assert.equal(completed, true, 'envio lento não bloqueia dispatch');
    await d(event(2, ADMIN)); assert.equal(fires, 1);
    a.close(); a = new Alerts({ dir: w.dir, env, now: () => w.clock.t });
    await a.notify({ number: UNKNOWN, evo: w.evo }); assert.equal(w.evo.calls.length, 0, 'reserva persistiu antes do envio terminar');
    finish({ kind: 'ok' });
    a.close(); a = new Alerts({ dir: w.dir, env: { GROUP_ALERT_ENABLED: 'true', OPERATOR_CONTACT: ADMIN }, now: () => w.clock.t });
    await a.notify({ number: '5585988883333', evo: w.evo }); assert.equal(w.evo.calls.length, 0);
    await a.notify({ group: GROUP, evo: w.evo }); assert.equal(w.evo.calls.length, 1);
  } finally { finish?.({ kind: 'ok' }); a?.close(); w.close(); }
});

test('dispatch consome rejeição de alerta em background sem registrar dados do erro', async () => {
  const w = world(); const logs = [];
  try {
    const d = createDispatcher({ env: { UNKNOWN_ALERT_ENABLED: 'true' }, cfg: {}, access: w.access, tasks: w.tasks, alerts: { notify: async () => { throw new Error('private-secret'); } }, log: (...args) => logs.push(args) });
    await d({ conv: `${UNKNOWN}@s.whatsapp.net`, sender: UNKNOWN, payload: {}, client: 'worki' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(logs.find(([name]) => name === 'alert_failed'), ['alert_failed']);
    assert.ok(!JSON.stringify(logs).includes('private-secret'));
  } finally { w.close(); }
});
