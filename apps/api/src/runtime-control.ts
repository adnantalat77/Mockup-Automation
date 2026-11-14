import crypto from 'node:crypto';
import type { Express } from 'express';

export function installShutdownRoute(app: Express, token: string | undefined, shutdown: () => Promise<void>) {
  if (!token || token.length < 32) return false;
  app.post('/api/runtime/shutdown', (request, response) => {
    const supplied = request.get('x-local-shutdown-token') ?? '';
    const expected = Buffer.from(token); const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return response.status(401).json({ error: 'Local shutdown authorization failed.' });
    response.status(202).json({ status: 'shutting_down' });
    setImmediate(() => void shutdown());
  });
  return true;
}
