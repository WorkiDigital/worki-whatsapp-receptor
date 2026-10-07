// Type-safe environment variable validation with no printed values
// Call validateEnv() at startup; it throws with details if validation fails.

const VARIABLES = [
  { key: 'EVOLUTION_WEBHOOK_SECRET', required: true, type: 'secret', minLength: 10, note: 'webhook security (X-Webhook-Secret header)' },
  { key: 'ALLOWED_CLIENTS', required: true, type: 'string', note: 'comma-separated client slugs (e.g. "worki,demo")' },
  { key: 'FORWARD_URL', required: false, type: 'url', note: 'HTTPS destination for messages (if empty, messages stay in queue)' },
  { key: 'FORWARD_TOKEN', required: false, type: 'secret', note: 'authorization for FORWARD_URL (Bearer token)' },
  { key: 'FORWARD_EXTRA_HEADERS', required: false, type: 'json', note: 'additional headers as JSON object' },
  { key: 'SEND_SECRET', required: false, type: 'secret', minLength: 10, note: 'security for POST /api/send (X-Send-Secret header)' },
  { key: 'EVOLUTION_API_URL', required: false, type: 'url', note: 'Evolution server URL for sending replies' },
  { key: 'EVOLUTION_API_KEY', required: false, type: 'secret', note: 'Evolution API key for sending replies' },
  { key: 'EVOLUTION_INSTANCE', required: false, type: 'string', note: 'Evolution instance name for sending' },
  { key: 'REPLY_PER_MINUTE', required: false, type: 'number', default: '5', note: 'rate limit (per-minute)' },
  { key: 'REPLY_PER_DAY', required: false, type: 'number', default: '50', note: 'rate limit (per-day)' },
  { key: 'PORT', required: false, type: 'port', default: '3000', note: 'HTTP server port' },
  { key: 'HOST', required: false, type: 'string', default: '0.0.0.0', note: 'HTTP server bind address' },
  { key: 'DATA_DIR', required: false, type: 'string', default: '/data', note: 'durable queue and private data directory' },
];

function validateType(key, value, spec) {
  if (!value) return true; // empty values pass type check (required check is separate)

  switch (spec.type) {
    case 'secret':
      return typeof value === 'string' && value.length >= (spec.minLength || 1);
    case 'string':
      return typeof value === 'string' && value.length > 0;
    case 'port':
      return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
    case 'number':
      return /^\d+$/.test(value) && Number(value) >= 0;
    case 'url':
      try { new URL(value); return true; } catch { return false; }
    case 'json':
      try { JSON.parse(value); return true; } catch { return false; }
    default:
      return true;
  }
}

export function validateEnv(env = process.env) {
  const errors = [];
  const validated = {};

  for (const spec of VARIABLES) {
    const value = env[spec.key] || spec.default || '';

    // Check required
    if (spec.required && !value) {
      errors.push(`${spec.key}: required but missing`);
      continue;
    }

    // Check type
    if (value && !validateType(spec.key, value, spec)) {
      errors.push(`${spec.key}: invalid format (expected ${spec.type}${spec.minLength ? `, min ${spec.minLength}` : ''})`);
      continue;
    }

    // Special: if FORWARD_URL is present, FORWARD_TOKEN must be too
    if (spec.key === 'FORWARD_URL' && value && !env.FORWARD_TOKEN) {
      errors.push('FORWARD_TOKEN: required when FORWARD_URL is set');
    }

    // Special: if SEND_SECRET is used, need EVOLUTION_API_URL/KEY/INSTANCE
    if (spec.key === 'SEND_SECRET' && value) {
      if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) {
        errors.push('EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE: required when SEND_SECRET is set');
      }
    }

    validated[spec.key] = value;
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n  ${errors.join('\n  ')}`);
  }

  return validated;
}

export function presence(env = process.env) {
  return Object.fromEntries(VARIABLES.map((v) => [v.key, Boolean(env[v.key])]));
}

export function configStatus(env = process.env) {
  const result = {};
  for (const spec of VARIABLES) {
    const present = Boolean(env[spec.key] || spec.default);
    result[spec.key] = {
      present,
      required: spec.required,
      type: spec.type,
      note: spec.note,
    };
  }
  return result;
}
