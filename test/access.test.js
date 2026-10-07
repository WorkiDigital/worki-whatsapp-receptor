import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessStore, AccessError } from '../lib/access.js';

const ADMIN = '5585992494552'; const MARIA = '5585988887777'; const JOAO = '5585977776666';
const mk = (t = { v: 1_800_000_000_000 }) => { const dir = mkdtempSync(join(tmpdir(), 'acc-')); return { dir, t, s: new AccessStore({ dir, admins: [ADMIN], now: () => t.v }) }; };

test('admin do ambiente pode tudo; desconhecido não tem acesso; ausência de concessão nega', () => {
  const { dir, s } = mk();
  try {
    assert.ok(s.hasAccess(ADMIN)); assert.ok(s.can(ADMIN, 'publish_instagram', 'x').ok);
    assert.ok(s.hasAccess('558592494552'), 'variante sem o 9');
    assert.ok(!s.hasAccess(MARIA)); assert.equal(s.can(MARIA, 'read_meta_insights', 'x').reason, 'unknown_person');
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('concessão: Maria consulta e prepara no cliente X, mas não publica nem acessa outro cliente', () => {
  const { dir, s } = mk();
  try {
    const v = s.grant({ by: ADMIN, number: `+${MARIA}`, name: 'Maria', clients: ['x'], ops: ['read_meta_insights', 'prepare_instagram_post'] });
    assert.equal(v.name, 'Maria'); assert.equal(v.grants[0].grantedBy, ADMIN);
    assert.ok(s.can(MARIA, 'read_meta_insights', 'x').ok);
    assert.ok(s.can(MARIA, 'prepare_instagram_post', 'x').ok);
    assert.ok(!s.can(MARIA, 'publish_instagram', 'x').ok);
    assert.ok(!s.can(MARIA, 'read_meta_insights', 'y').ok);
    assert.ok(!s.can(MARIA, 'read_meta_insights', undefined).ok);
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('validade, suspensão, reativação e revogação (inclui concessões)', () => {
  const { dir, t, s } = mk();
  try {
    s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'], expiresAt: new Date(t.v + 3600_000).toISOString() });
    assert.ok(s.can(MARIA, 'read_meta_insights', 'x').ok);
    t.v += 3601_000; assert.ok(!s.can(MARIA, 'read_meta_insights', 'x').ok, 'expirou'); assert.ok(!s.hasAccess(MARIA));
    s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'] });
    s.setStatus({ by: ADMIN, number: MARIA, status: 'suspended' });
    assert.equal(s.can(MARIA, 'read_meta_insights', 'x').reason, 'suspended');
    s.setStatus({ by: ADMIN, number: MARIA, status: 'active' }); assert.ok(s.can(MARIA, 'read_meta_insights', 'x').ok);
    s.setStatus({ by: ADMIN, number: MARIA, status: 'revoked' }); assert.ok(!s.hasAccess(MARIA));
    assert.throws(() => s.setStatus({ by: ADMIN, number: MARIA, status: 'active' }), { code: 'revoked' });
    assert.throws(() => s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'], expiresAt: new Date(t.v - 1).toISOString() }), { code: 'invalid_expiry' });
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('modo set substitui concessões ativas; revoke_grant tira só uma', () => {
  const { dir, s } = mk();
  try {
    s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights', 'publish_instagram'] });
    s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights'], mode: 'set' });
    assert.ok(!s.can(MARIA, 'publish_instagram', 'x').ok); assert.ok(s.can(MARIA, 'read_meta_insights', 'x').ok);
    const id = s.view(MARIA).grants.find((g) => g.active).id;
    s.revokeGrant({ by: ADMIN, number: MARIA, grantId: id }); assert.ok(!s.hasAccess(MARIA));
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('escopo de administração: gestor de um cliente não escala, não cria admin, não toca outros clientes nem o admin', () => {
  const { dir, s } = mk();
  try {
    s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['read_meta_insights', 'prepare_instagram_post', 'manage_access'] });
    s.grant({ by: MARIA, number: JOAO, clients: ['x'], ops: ['read_meta_insights'] });
    assert.ok(s.can(JOAO, 'read_meta_insights', 'x').ok);
    const bad = (fn, code) => assert.throws(fn, (e) => e instanceof AccessError && e.code === code, code);
    bad(() => s.grant({ by: MARIA, number: JOAO, clients: ['x'], ops: ['publish_instagram'] }), 'forbidden');      // ela não tem publish
    bad(() => s.grant({ by: MARIA, number: JOAO, clients: ['y'], ops: ['read_meta_insights'] }), 'forbidden');     // outro cliente
    bad(() => s.grant({ by: MARIA, number: JOAO, clients: ['*'], ops: ['read_meta_insights'] }), 'forbidden');     // curinga
    bad(() => s.grant({ by: MARIA, number: JOAO, clients: ['x'], ops: ['manage_access'] }), 'forbidden');         // criar gestor
    bad(() => s.grant({ by: MARIA, number: ADMIN, clients: ['x'], ops: ['read_meta_insights'] }), 'forbidden');   // alterar admin
    bad(() => s.setStatus({ by: JOAO, number: MARIA, status: 'revoked' }), 'forbidden');                           // sem manage_access
    s.setStatus({ by: MARIA, number: JOAO, status: 'suspended' });                                                  // dentro do escopo
    s.grant({ by: ADMIN, number: JOAO, clients: ['y'], ops: ['read_meta_insights'] });
    bad(() => s.setStatus({ by: MARIA, number: JOAO, status: 'revoked' }), 'forbidden');                           // JOAO também tem y
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('validações: número sem DDI, operação desconhecida, cliente inválido', () => {
  const { dir, s } = mk();
  try {
    assert.throws(() => s.grant({ by: ADMIN, number: '85988887777', clients: ['x'], ops: ['read_meta_insights'] }), { code: 'invalid_number' });
    assert.throws(() => s.grant({ by: ADMIN, number: MARIA, clients: ['x'], ops: ['hackear'] }), { code: 'invalid_ops' });
    assert.throws(() => s.grant({ by: ADMIN, number: MARIA, clients: ['X Y'], ops: ['read_meta_insights'] }), { code: 'invalid_clients' });
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('grupos: só registrados e ativos; remover tira; participar não dá acesso', () => {
  const { dir, s } = mk();
  const jid = '120363000000000001@g.us';
  try {
    assert.equal(s.group(jid), null);
    s.registerGroup({ by: ADMIN, jid, client: 'x', name: 'Operação' });
    assert.equal(s.group(jid).client, 'x'); assert.ok(!s.hasAccess(MARIA), 'estar no grupo não concede nada');
    assert.throws(() => s.registerGroup({ by: MARIA, jid, client: 'x' }), { code: 'forbidden' });
    s.removeGroup({ by: ADMIN, jid }); assert.equal(s.group(jid), null);
    assert.throws(() => s.registerGroup({ by: ADMIN, jid: 'abc', client: 'x' }), { code: 'invalid_group' });
  } finally { s.close(); rmSync(dir, { recursive: true }); }
});

test('persistência: reabrir reconstrói pessoas, concessões, revogações e grupos; cauda truncada é ignorada', async () => {
  const { dir, s } = mk();
  const { appendFileSync } = await import('node:fs');
  s.grant({ by: ADMIN, number: MARIA, name: 'Maria', clients: ['x'], ops: ['read_meta_insights'] });
  s.grant({ by: ADMIN, number: JOAO, clients: ['x'], ops: ['read_meta_insights'] });
  s.setStatus({ by: ADMIN, number: JOAO, status: 'revoked' });
  s.registerGroup({ by: ADMIN, jid: '120363000000000001@g.us', client: 'x' });
  s.close();
  appendFileSync(join(dir, 'access.jsonl'), '{"t":"grant","id":"truncad');
  const r = new AccessStore({ dir, admins: [ADMIN] });
  try {
    assert.ok(r.can(MARIA, 'read_meta_insights', 'x').ok); assert.equal(r.view(MARIA).name, 'Maria');
    assert.ok(!r.hasAccess(JOAO)); assert.ok(r.group('120363000000000001@g.us'));
    assert.equal(r.journal.corruptLines, 1);
    r.grant({ by: ADMIN, number: JOAO, clients: ['x'], ops: ['read_meta_insights'] });   // continua gravando após a cauda ruim
    assert.ok(new AccessStore({ dir, admins: [ADMIN] }).hasAccess(JOAO));
  } finally { r.close(); rmSync(dir, { recursive: true }); }
});
