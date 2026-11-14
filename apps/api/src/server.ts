import { config as loadEnvironment } from 'dotenv';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startApi } from './runtime.js';
import { installShutdownRoute } from './runtime-control.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const runtimeLog = process.env.MOCKUP_LOG_FILE;
if (runtimeLog) {
  const record = (level: string, values: unknown[]) => {
    const message = values.map((value) => value instanceof Error ? value.stack ?? value.message : typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
    appendFileSync(runtimeLog, `${new Date().toISOString()} ${level} ${message}\n`, 'utf8');
  };
  console.log = (...values: unknown[]) => record('INFO', values);
  console.error = (...values: unknown[]) => record('ERROR', values);
}

try {
  const runtime = await startApi();
  const address = runtime.server.address();
  const port = typeof address === 'object' && address ? address.port : Number(process.env.API_PORT ?? 3001);
  console.log(`Mockup Automation API: http://127.0.0.1:${port}`);
  let shutdownAttempt: Promise<void> | undefined;
  const shutdown = () => {
    shutdownAttempt ??= runtime.stop().catch((error) => {
      shutdownAttempt = undefined;
      console.error(error instanceof Error ? error.message : 'API shutdown failed.');
      process.exitCode = 1;
    });
    return shutdownAttempt;
  };
  installShutdownRoute(runtime.app, process.env.MOCKUP_SHUTDOWN_TOKEN, async () => { await shutdown(); process.exitCode = 0; });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Mockup Automation API startup failed.');
  process.exitCode = 1;
}
