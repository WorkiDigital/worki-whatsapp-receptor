import { createHash, timingSafeEqual } from 'node:crypto';
const h = (s) => createHash('sha256').update(String(s)).digest();
export const validSecret = (expected, got) => Boolean(expected) && typeof got === 'string' && timingSafeEqual(h(expected), h(got));
