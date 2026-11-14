import crypto from 'node:crypto';
import type { Express } from 'express';

export interface RuntimeIdentity {
  instanceToken: string;
  shutdownToken: string;
  startupId: string;
  appRoot: string;
  dataDir: string;
  pid: number;
}

function authorized(expectedValue: string, suppliedValue = '') {
  const expected = Buffer.from(expectedValue); const supplied = Buffer.from(suppliedValue);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function installRuntimeControl(app: Express, identity: RuntimeIdentity | undefined, shutdown: () => Promise<void>) {
  if (!identity || identity.instanceToken.length < 32 || identity.shutdownToken.length < 32 || !identity.startupId || !identity.appRoot || !identity.dataDir || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return false;
  app.post('/api/runtime/identity', (request, response) => {
    if (!authorized(identity.instanceToken, request.get('x-local-instance-token'))) return response.status(401).json({ error: 'Local instance authorization failed.' });
    response.json({ application: 'mockup-automation', phase: 4, startupId: identity.startupId, pid: identity.pid, appRoot: identity.appRoot, dataDir: identity.dataDir });
  });
  app.post('/api/runtime/shutdown', (request, response) => {
    if (!authorized(identity.shutdownToken, request.get('x-local-shutdown-token'))) return response.status(401).json({ error: 'Local shutdown authorization failed.' });
    response.status(202).json({ status: 'shutting_down', startupId: identity.startupId });
    setImmediate(() => void shutdown());
  });
  return true;
}

export function installShutdownRoute(app: Express, token: string | undefined, shutdown: () => Promise<void>) {
  return installRuntimeControl(app, token ? { instanceToken: token, shutdownToken: token, startupId: 'legacy-test', appRoot: 'legacy-test', dataDir: 'legacy-test', pid: process.pid } : undefined, shutdown);
}
