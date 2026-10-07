import { waitUntil } from '@vercel/functions';
import { createHandler } from '../../lib/handler.js';

// POST /api/evolution/<cliente> — URL a configurar na instância Evolution (EVOLUTION_WEBHOOK_URL).
export default createHandler({ waitUntil });
