import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { startApi } from './runtime.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

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
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Mockup Automation API startup failed.');
  process.exitCode = 1;
}
