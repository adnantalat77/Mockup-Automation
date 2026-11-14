import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { installRuntimeControl, installShutdownRoute } from './runtime-control.js';

describe('local graceful shutdown control', () => {
  it('does not install without a strong process-local token', async () => {
    const app = express(); const shutdown = vi.fn();
    expect(installShutdownRoute(app, 'short', shutdown)).toBe(false);
    expect((await request(app).post('/api/runtime/shutdown')).status).toBe(404);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('rejects incorrect authorization and schedules shutdown only after an accepted request', async () => {
    const app = express(); const shutdown = vi.fn().mockResolvedValue(undefined); const token = 'a'.repeat(64);
    expect(installShutdownRoute(app, token, shutdown)).toBe(true);
    expect((await request(app).post('/api/runtime/shutdown').set('X-Local-Shutdown-Token', 'wrong')).status).toBe(401);
    expect(shutdown).not.toHaveBeenCalled();
    expect((await request(app).post('/api/runtime/shutdown').set('X-Local-Shutdown-Token', token)).status).toBe(202);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it('authenticates instance identity without exposing either capability publicly', async () => {
    const app = express(); const shutdown = vi.fn().mockResolvedValue(undefined);
    const identity = { instanceToken: 'i'.repeat(64), shutdownToken: 's'.repeat(64), startupId: 'startup-123', appRoot: 'C:\\Mockup Automation', dataDir: 'C:\\Mockup Data', pid: 4321 };
    expect(installRuntimeControl(app, identity, shutdown)).toBe(true);
    expect((await request(app).post('/api/runtime/identity')).status).toBe(401);
    expect((await request(app).post('/api/runtime/identity').set('X-Local-Instance-Token', 'wrong')).status).toBe(401);
    const verified = await request(app).post('/api/runtime/identity').set('X-Local-Instance-Token', identity.instanceToken);
    expect(verified).toMatchObject({ status: 200, body: { application: 'mockup-automation', phase: 4, startupId: identity.startupId, pid: identity.pid, appRoot: identity.appRoot, dataDir: identity.dataDir } });
    expect(JSON.stringify(verified.body)).not.toContain(identity.instanceToken); expect(JSON.stringify(verified.body)).not.toContain(identity.shutdownToken);
  });
});
