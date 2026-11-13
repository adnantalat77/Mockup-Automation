import crypto from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

export class InstanceLockError extends Error {
  constructor(message: string, readonly causeCode?: string) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export interface DataDirectoryLock {
  canonicalDataDir: string;
  identity: string;
  endpoint: string;
  release(): Promise<void>;
}

export function normalizeCanonicalPath(canonicalPath: string, platform: NodeJS.Platform = process.platform) {
  const parsed = path.parse(canonicalPath);
  let normalized = path.normalize(canonicalPath);
  while (normalized.length > parsed.root.length && (normalized.endsWith(path.sep) || normalized.endsWith('/'))) normalized = normalized.slice(0, -1);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export async function canonicalizeDataDirectory(dataDir: string) {
  const absolute = path.resolve(dataDir);
  await mkdir(absolute, { recursive: true });
  const canonicalDataDir = await realpath(absolute);
  return { canonicalDataDir, identity: normalizeCanonicalPath(canonicalDataDir) };
}

export function lockEndpointForIdentity(identity: string, platform: NodeJS.Platform = process.platform) {
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\mockup-automation-${digest}`;
  return path.join(process.env.TMPDIR ?? process.env.TEMP ?? '/tmp', `mockup-automation-${digest}.sock`);
}

export async function acquireDataDirectoryLock(dataDir: string): Promise<DataDirectoryLock> {
  const { canonicalDataDir, identity } = await canonicalizeDataDirectory(dataDir);
  const endpoint = lockEndpointForIdentity(identity);
  const server = net.createServer((socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      const occupied = error.code === 'EADDRINUSE' || error.code === 'EACCES';
      reject(new InstanceLockError(
        occupied
          ? `Mockup Automation is already running against this data directory: ${canonicalDataDir}`
          : `Mockup Automation could not acquire the data-directory lock for ${canonicalDataDir}: ${error.message}`,
        error.code
      ));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });

  let released = false;
  let releaseAttempt: Promise<void> | undefined;
  return {
    canonicalDataDir,
    identity,
    endpoint,
    async release() {
      if (released) return;
      releaseAttempt ??= new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        .then(() => { released = true; })
        .finally(() => { if (!released) releaseAttempt = undefined; });
      await releaseAttempt;
    }
  };
}
