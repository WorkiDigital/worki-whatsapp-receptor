import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEnv, parseEnvText } from '../lib/envaudit.js';
test('env-audit: valida flags/janelas novas sem imprimir valores privados', () => {
  const r = auditEnv(parseEnvText('HISTORY_ENABLED=yes\nGROUP_REQUIRE_MENTION=yes\nUNKNOWN_ALERT_ENABLED=true\nALERT_INCLUDE_TEXT=yes\nHISTORY_MESSAGES=0\nHISTORY_MAX_AGE_HOURS=-1\nALERT_PER_HOUR=abc\nAGENT_NUMBER=5585000000000'));
  for (const key of ['HISTORY_ENABLED', 'GROUP_REQUIRE_MENTION', 'ALERT_INCLUDE_TEXT', 'HISTORY_MESSAGES', 'HISTORY_MAX_AGE_HOURS', 'ALERT_PER_HOUR', 'OPERATOR_CONTACT']) assert.ok(r.problems.some((p) => p.includes(key)));
  assert.ok(!JSON.stringify(r).includes('5585000000000'));
});
