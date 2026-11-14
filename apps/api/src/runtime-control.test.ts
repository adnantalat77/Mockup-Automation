import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { installShutdownRoute } from './runtime-control.js';

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
});
