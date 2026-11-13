import { appendFile } from 'node:fs/promises';
import { acquireDataDirectoryLock } from '../services/instance-lock.js';

const [dataDir, mutationMarker = ''] = process.argv.slice(2);
if (!dataDir) throw new Error('A data directory is required.');

try {
  const lock = await acquireDataDirectoryLock(dataDir);
  if (mutationMarker) await appendFile(mutationMarker, `${process.pid}\n`);
  process.send?.({ type: 'acquired', canonicalDataDir: lock.canonicalDataDir });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await lock.release();
    process.exit(0);
  };
  process.on('message', (message) => { if (message === 'release') void stop(); });
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
} catch (error) {
  process.send?.({ type: 'rejected', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 2;
}
