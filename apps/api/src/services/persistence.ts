import crypto from 'node:crypto';
import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export class PersistenceError extends Error {
  constructor(message: string, readonly code?: string, readonly cause?: unknown) { super(message); this.name = 'PersistenceError'; }
}

export type AtomicWriter = (destination: string, data: string | Buffer) => Promise<void>;
export interface AtomicWriteFaultHooks { beforeWrite?(): void; beforeFlush?(): void; beforeRename?(): void }

export async function atomicWriteFile(destination: string, data: string | Buffer, hooks: AtomicWriteFaultHooks = {}) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx');
    hooks.beforeWrite?.();
    await handle.writeFile(data);
    hooks.beforeFlush?.();
    await handle.sync();
    await handle.close(); handle = undefined;
    hooks.beforeRename?.();
    try { await rename(temporary, destination); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(code ?? '')) throw error;
      const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.replace-backup`);
      await stat(destination); await rename(destination, backup);
      try { await rename(temporary, destination); }
      catch (replacementError) { await rename(backup, destination); throw replacementError; }
      await unlink(backup);
    }
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(destination), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    const cause = error as NodeJS.ErrnoException;
    throw new PersistenceError(`Could not durably write ${path.basename(destination)}${cause.code ? ` (${cause.code})` : ''}.`, cause.code, error);
  }
}

export async function recoverInterruptedReplacements(directory: string) {
  const suffix = /^(?:\.)(.+)\.[0-9a-f-]{36}\.replace-backup$/i;
  for (const name of await readdir(directory)) {
    const match = suffix.exec(name); if (!match) continue;
    const destination = path.join(directory, match[1]);
    try { await stat(destination); continue; /* New or old committed file exists; preserve uncertain backup. */ }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(path.join(directory, name), destination);
  }
}
