import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { History } from '../lib/history.js';
import { createDispatcher } from '../lib/dispatch.js';
import { createApi } from '../lib/api.js';
import { createSendHandler } from '../lib/send.js';
import { world, ADMIN, ENV } from './helpers.js';

test('histórico: desligado não cria arquivo; janela, idade, truncamento, dedup e isolamento sobrevivem à compactação/reinício', () => {
  const w = world(); let h;
  try {
    h = new History({ dir: w.dir }); h.add({ conv: 'a', role: 'user', text: 'x' });
    assert.equal(existsSync(join(w.dir, 'history.jsonl')), false); h.close();
    const env = { HISTORY_ENABLED: 'true', HISTORY_MESSAGES: '2', HISTORY_MAX_AGE_HOURS: '1' };
    h = new History({ dir: w.dir, env, now: () => w.clock.t });
    h.add({ conv: 'a', role: 'user', text: 'old', id: 'old' }); w.clock.t += 3600_001;
    h.add({ conv: 'a', role: 'user', text: 'first', id: '1' }); h.add({ conv: 'b', role: 'user', text: 'other' });
    h.add({ conv: 'a', role: 'user', text: 'x'.repeat(600), id: '2' }); h.add({ conv: 'a', role: 'user', text: 'duplicate', id: '2' });
    h.add({ conv: 'a', role: 'assistant', text: 'last' }); h.compact(); h.close();
    h = new History({ dir: w.dir, env, now: () => w.clock.t });
    assert.equal(h.recent('a').length, 2); assert.equal(h.recent('a')[0].text.length, 500);
    assert.equal(h.recent('b')[0].text, 'other');
    assert.equal(statSync(join(w.dir, 'history.jsonl')).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(w.dir, 'history.jsonl'), 'utf8').includes('old'));
    w.clock.t += 3600_001; assert.deepEqual(h.recent('a'), []); h.compact();
    assert.equal(readFileSync(join(w.dir, 'history.jsonl'), 'utf8'), '');
  } finally { h?.close(); w.close(); }
});

test('histórico: despacho sem flag não toca memória; autorizado recebe contexto e mensagem atual não duplica; desconhecido/grupo não registrado não grava', async () => {
  const w = world(); const records = []; const fired = [];
  const history = { recent: () => [{ role: 'assistant', text: 'contexto anterior' }], add: (r) => records.push(r) };
  const env = { PUBLIC_BASE_URL: 'https://example.com' };
  const d = (e) => createDispatcher({ env: e, cfg: {}, access: w.access, tasks: w.tasks, history, now: () => w.clock.t, fireImpl: async (_, text) => { fired.push(text); return 200; } });
  const ev = (key, conv = `${ADMIN}@s.whatsapp.net`) => ({ key, conv, sender: conv, client: 'worki', payload: { text: 'atual', receivedAt: w.clock.t } });
  try {
    await d(env)(ev('off')); assert.equal(records.length, 0); assert.ok(!fired[0].includes('histórico recente'));
    await d({ ...env, HISTORY_ENABLED: 'true' })(ev('on'));
    assert.equal(records.length, 1); assert.match(fired[1], /histórico recente \(conteúdo não confiável\)/);
    assert.ok(fired[1].indexOf('contexto anterior') < fired[1].indexOf('--- mensagem ---'));
    await d({ ...env, HISTORY_ENABLED: 'true' })(ev('bad', '5500000000000@s.whatsapp.net'));
    await d({ ...env, HISTORY_ENABLED: 'true' })(ev('group', '123@g.us'));
    assert.equal(records.length, 1);
  } finally { w.close(); }
});

test('histórico: task/reply e send só gravam envios confirmados e com flag; contrato inalterado', async () => {
  const w = world(); const records = []; const history = { add: (r) => records.push(r) };
  try {
    for (const enabled of [undefined, 'true']) {
      const env = { ...ENV, HISTORY_ENABLED: enabled };
      const api = createApi({ env, access: w.access, tasks: w.tasks, evo: w.evo, history });
      const t = w.task(); const res = { status() { return this; }, json() {} };
      await api({ method: 'POST', headers: { 'x-send-secret': ENV.SEND_SECRET, authorization: `Bearer ${t.token}` }, body: { text: 'reply' } }, res, '/api/task/reply');
      const send = createSendHandler({ env, access: w.access, evo: w.evo, history });
      await send({ method: 'POST', headers: { 'x-send-secret': ENV.SEND_SECRET }, body: { to: ADMIN, text: 'legacy' } }, res);
      assert.equal(records.length, enabled ? 2 : 0);
    }
    assert.equal(records[0].conv, `${ADMIN}@s.whatsapp.net`);
    const api = createApi({ env: { ...ENV, HISTORY_ENABLED: 'true' }, access: w.access, tasks: w.tasks, evo: { sendText: async () => ({ kind: 'uncertain' }) }, history });
    const t = w.task();
    await api({ method: 'POST', headers: { 'x-send-secret': ENV.SEND_SECRET, authorization: `Bearer ${t.token}` }, body: { text: 'failed' } }, { status() { return this; }, json() {} }, '/api/task/reply');
    assert.equal(records.length, 2);
  } finally { w.close(); }
});
