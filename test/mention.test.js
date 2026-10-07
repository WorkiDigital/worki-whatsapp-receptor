import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvolutionEvent } from '../lib/evolution.js';
import { createStore } from '../lib/store.js';
import { createDispatcher } from '../lib/dispatch.js';
import { world, ADMIN } from './helpers.js';
const GROUP = '120363000000000001@g.us';
const BOT = '5585988881111';

test('menção: parse de texto/imagem/vídeo e fila preservam contexto citado e identidade da instância', () => {
  const w = world(); const store = createStore(w.dir);
  try {
    for (const type of ['extendedTextMessage', 'imageMessage', 'videoMessage']) {
      const msg = parseEvolutionEvent({ event: 'messages.upsert', sender: `${BOT}@s.whatsapp.net`, data: { key: { id: type, remoteJid: GROUP, participant: `${ADMIN}@s.whatsapp.net` }, message: { [type]: { text: 'oi', caption: 'oi', contextInfo: { mentionedJid: ['1@lid'], mentionedJidAlt: [`${BOT}@s.whatsapp.net`], participant: '2@lid', participantAlt: `${BOT}@s.whatsapp.net`, stanzaId: 'quoted' } } } } });
      assert.equal(msg.senderId, `${ADMIN}@s.whatsapp.net`);
      store.enqueue({ client: 'worki', msg }); const e = store.queue.claim();
      assert.deepEqual(e.payload.mentionedJid, ['1@lid']); assert.equal(e.payload.participant, '2@lid');
      assert.equal(e.payload.instanceSender, `${BOT}@s.whatsapp.net`); assert.equal(e.payload.quotedMessage, true);
      assert.equal(e.payload.mentionedJidAlt[0], `${BOT}@s.whatsapp.net`); store.queue.complete(e.key);
    }
  } finally { store.close(); w.close(); }
});

test('menção: flag bloqueia ausência, terceiros, LID sem alternativo e citação sem referência; privado não filtra; desligado libera', async () => {
  const w = world(); const fired = []; const logs = []; const mentionState = {};
  const env = { PUBLIC_BASE_URL: 'https://example.com', GROUP_REQUIRE_MENTION: 'true', AGENT_NUMBER: BOT };
  const d = (e = env) => createDispatcher({ env: e, cfg: {}, access: w.access, tasks: w.tasks, mentionState, now: () => w.clock.t, log: (e, f) => logs.push([e, f]), fireImpl: async (_, t) => { fired.push(t); return 200; } });
  let id = 0;
  const event = (payload = {}, conv = GROUP) => ({ key: `worki:${++id}`, conv, sender: `${ADMIN}@s.whatsapp.net`, client: 'worki', payload: { text: 'private-text', receivedAt: w.clock.t, ...payload } });
  try {
    w.access.registerGroup({ by: ADMIN, jid: GROUP, client: 'worki' });
    for (const p of [{}, { mentionedJid: ['5511000000000@s.whatsapp.net'] }, { mentionedJid: [`${BOT}@lid`] }, { participant: `${BOT}@s.whatsapp.net` }]) await d()(event(p));
    assert.equal(fired.length, 0); assert.equal(logs.filter(([, f]) => f.code === 'not_mentioned').length, 4);
    for (const p of [{ mentionedJid: [`${BOT}@s.whatsapp.net`] }, { mentionedJid: ['558588881111@s.whatsapp.net'] }, { mentionedJid: ['1@lid'], mentionedJidAlt: [`${BOT}@s.whatsapp.net`] }, { mentionedJid: [{ jid: '1@lid', number: BOT }] }, { quotedMessage: true, participant: `${BOT}@s.whatsapp.net` }, { quotedMessage: true, participant: '2@lid', participantAlt: `${BOT}@s.whatsapp.net` }]) await d()(event(p));
    assert.equal(fired.length, 6);
    await d()(event({}, `${ADMIN}@s.whatsapp.net`)); await d({ ...env, GROUP_REQUIRE_MENTION: 'false' })(event());
    assert.equal(fired.length, 8);
    await d({ ...env, AGENT_NUMBER: '' })(event({ instanceSender: `${BOT}@s.whatsapp.net` })); assert.equal(fired.length, 8);
    await d({ ...env, AGENT_NUMBER: '' })(event()); assert.equal(fired.length, 9); assert.equal(mentionState.selfUnknown, true);
    assert.ok(logs.some(([e, f]) => e === 'mention_filter_inactive' && f.code === 'self_unknown'));
    assert.ok(!logs.some(([e, f]) => e === 'skipped' && f.code === 'self_unknown'));
    for (const s of ['private-text', ADMIN, BOT, GROUP]) assert.ok(!JSON.stringify(logs).includes(s));
  } finally { w.close(); }
});

test('menção: fixture data.contextInfo é fallback; contexto específico prevalece sem perder campos', () => {
  for (const type of ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage']) {
    const msg = parseEvolutionEvent({ event: 'messages.upsert', data: {
      key: { id: type, remoteJid: GROUP, participant: `${ADMIN}@s.whatsapp.net` },
      contextInfo: { mentionedJid: [`${BOT}@s.whatsapp.net`], participant: `${BOT}@s.whatsapp.net`, stanzaId: 'quoted' },
      message: type === 'conversation' ? { conversation: 'oi' } : { [type]: { caption: 'oi', contextInfo: { participant: 'override@s.whatsapp.net' } } },
    } });
    assert.deepEqual(msg.mentionedJid, [`${BOT}@s.whatsapp.net`]);
    assert.equal(msg.quotedMessage, true);
    assert.equal(msg.participant, type === 'conversation' ? `${BOT}@s.whatsapp.net` : 'override@s.whatsapp.net');
  }
});
