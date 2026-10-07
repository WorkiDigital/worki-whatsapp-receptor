import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditEnv, parseEnvText } from '../lib/envaudit.js';
test('env-audit: valida flags/janelas novas sem imprimir valores privados', () => {
  const r = auditEnv(parseEnvText('HISTORY_ENABLED=yes\nGROUP_REQUIRE_MENTION=yes\nUNKNOWN_ALERT_ENABLED=true\nALERT_INCLUDE_TEXT=yes\nHISTORY_MESSAGES=0\nHISTORY_MAX_AGE_HOURS=-1\nALERT_PER_HOUR=abc\nAGENT_NUMBER=5585000000000'));
  for (const key of ['HISTORY_ENABLED', 'GROUP_REQUIRE_MENTION', 'ALERT_INCLUDE_TEXT', 'HISTORY_MESSAGES', 'HISTORY_MAX_AGE_HOURS', 'ALERT_PER_HOUR', 'OPERATOR_CONTACT']) assert.ok(r.problems.some((p) => p.includes(key)));
  assert.ok(!JSON.stringify(r).includes('5585000000000'));
});

test('env-audit: GROUP_ALERT_ENABLED valida booleano e exige contato independentemente de alertas privados', () => {
  assert.ok(auditEnv(parseEnvText('GROUP_ALERT_ENABLED=yes')).problems.some((p) => p === 'GROUP_ALERT_ENABLED: use true ou false'));
  assert.ok(auditEnv(parseEnvText('GROUP_ALERT_ENABLED=true\nUNKNOWN_ALERT_ENABLED=false')).problems.includes('GROUP_ALERT_ENABLED exige OPERATOR_CONTACT'));
});

test('docs: controle de grupos nasce desligado e guias descrevem backup e filtro inativo', () => {
  assert.match(readFileSync('.env.example', 'utf8'), /^GROUP_ALERT_ENABLED=false$/m);
  for (const path of ['ROUTINE.md', 'docs/deploy.md']) {
    const text = readFileSync(path, 'utf8');
    for (const value of ['GROUP_ALERT_ENABLED=false', 'mention_filter_inactive', 'history.jsonl', 'alerts.jsonl']) assert.ok(text.includes(value), `${path}: ${value}`);
    for (const heading of ['Histórico opcional', 'Menção em grupos', 'Avisos opcionais de acesso', 'Memória recente (opcional)', 'Filtro de menção (opcional)', 'Alertas de desconhecidos (opcional)']) {
      if (text.includes(`## ${heading}`)) assert.ok(text.includes(`\n\n## ${heading}`));
    }
  }
  const deploy = readFileSync('docs/deploy.md', 'utf8');
  assert.ok(deploy.indexOf('Validação desta entrega:') > deploy.lastIndexOf('\n## '));
});
