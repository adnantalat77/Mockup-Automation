import type { Server } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { acquireDataDirectoryLock, type DataDirectoryLock } from './services/instance-lock.js';

interface RuntimeDependencies {
  createApplication(overrides: Partial<AppConfig>): Promise<Express>;
  listenPort?: number;
}

export interface ApiRuntime {
  app: Express;
  server: Server;
  lock: DataDirectoryLock;
  stop(): Promise<void>;
}

export async function startApi(
  overrides: Partial<AppConfig> = {},
  dependencies: RuntimeDependencies = { createApplication: createApp }
): Promise<ApiRuntime> {
  const config = loadConfig(overrides);
  const lock = await acquireDataDirectoryLock(config.dataDir);
  let server: Server | undefined;
  try {
    const restoreJournal = path.join(path.dirname(lock.canonicalDataDir), `.${path.basename(lock.canonicalDataDir)}.restore-transaction.json`);
    try { await access(restoreJournal); throw new Error(`An interrupted restoration journal exists at ${restoreJournal}. API startup is blocked until the preserved live, previous, and staged directories are reconciled.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const app = await dependencies.createApplication({ ...config, dataDir: lock.canonicalDataDir });
    server = await new Promise<Server>((resolve, reject) => {
      const candidate = app.listen(dependencies.listenPort ?? Number(process.env.API_PORT ?? 3001), '127.0.0.1');
      candidate.once('listening', () => resolve(candidate));
      candidate.once('error', reject);
    });
    let stopped = false;
    let stopAttempt: Promise<void> | undefined;
    return {
      app,
      server,
      lock,
      async stop() {
        if (stopped) return;
        if (!stopAttempt) {
          stopAttempt = (async () => {
            await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
            await lock.release();
            stopped = true;
          })();
        }
        try { await stopAttempt; }
        finally { if (!stopped) stopAttempt = undefined; }
      }
    };
  } catch (error) {
    if (server?.listening) {
      try { await new Promise<void>((resolve, reject) => server!.close((closeError) => closeError ? reject(closeError) : resolve())); }
      catch (closeError) {
        throw new AggregateError([error, closeError], 'API startup failed and the HTTP server could not be closed; data-directory ownership remains held until process termination.');
      }
    }
    await lock.release();
    throw error;
  }
}
