import crypto from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { acquireDataDirectoryLock } from './instance-lock.js';
import { atomicWriteFile } from './persistence.js';
import { validatePublicationCheckpointData } from './publishing.js';

interface BackupEntry { path: string; size: number; sha256: string }
interface BackupManifest { version: 1; createdAt: string; files: BackupEntry[] }

export class BackupError extends Error { constructor(message: string) { super(message); this.name = 'BackupError'; } }
export interface RestoreFaultHooks { afterLiveMoved?(): Promise<void> | void; afterPromotion?(): Promise<void> | void }

async function filesBelow(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name.endsWith('.tmp')) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(root, absolute));
    else if (entry.isFile()) result.push(path.relative(root, absolute).replaceAll('\\', '/'));
    else throw new BackupError(`Backup source contains an unsupported link or reparse point: ${path.relative(root, absolute)}.`);
  }
  return result.sort();
}

function safePath(root: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new BackupError('Backup manifest contains an unsafe path.');
  const absolute = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`.toLowerCase();
  if (!absolute.toLowerCase().startsWith(prefix)) throw new BackupError('Backup manifest path escapes the backup root.');
  return absolute;
}

async function hashFile(filename: string) { return crypto.createHash('sha256').update(await readFile(filename)).digest('hex'); }

export async function validateBackup(backupRoot: string) {
  const root = path.resolve(backupRoot); let manifest: BackupManifest;
  try { manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as BackupManifest; }
  catch (error) { throw new BackupError(`Backup manifest is missing or unreadable: ${error instanceof Error ? error.message : 'invalid JSON'}`); }
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.some((entry) => !entry || typeof entry.path !== 'string' || typeof entry.size !== 'number' || typeof entry.sha256 !== 'string')) throw new BackupError('Backup manifest structure is invalid.');
  if (new Set(manifest.files.map((entry) => entry.path.toLowerCase())).size !== manifest.files.length) throw new BackupError('Backup manifest contains duplicate or case-colliding Windows paths.');
  const payload = path.join(root, 'data');
  const actual = await filesBelow(payload).catch(() => { throw new BackupError('Backup data directory is missing or unreadable.'); });
  const expected = manifest.files.map((entry) => entry.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new BackupError('Backup file set does not match its manifest.');
  for (const entry of manifest.files) {
    const filename = safePath(payload, entry.path); const info = await stat(filename);
    if (info.size !== entry.size || await hashFile(filename) !== entry.sha256) throw new BackupError(`Backup integrity mismatch for ${entry.path}.`);
  }
  const batchEntries = manifest.files.filter((entry) => /^batches\/[^/]+\.json$/.test(entry.path));
  for (const entry of batchEntries) {
    try {
      const batch = JSON.parse(await readFile(safePath(payload, entry.path), 'utf8')) as { id?: string; status?: string; items?: unknown[] };
      if (batch.id !== path.basename(entry.path, '.json') || !['running', 'completed', 'partial', 'cancelled'].includes(batch.status ?? '') || !Array.isArray(batch.items)) throw new Error('invalid batch structure');
    } catch (error) { throw new BackupError(`Backup batch metadata is invalid for ${entry.path}: ${error instanceof Error ? error.message : 'invalid JSON'}.`); }
  }
  const publicationGroups = new Map<string, BackupEntry[]>();
  for (const entry of manifest.files.filter((candidate) => /^publications\/[^/]+\/\d{6}\.json$/.test(candidate.path))) {
    const operationId = entry.path.split('/')[1]; publicationGroups.set(operationId, [...(publicationGroups.get(operationId) ?? []), entry]);
  }
  for (const [operationId, entries] of publicationGroups) {
    let recovered = false;
    for (const entry of entries.sort((left, right) => right.path.localeCompare(left.path))) {
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(safePath(payload, entry.path), 'utf8')); }
      catch { continue; }
      try { validatePublicationCheckpointData(parsed, operationId, entry.path); recovered = true; break; }
      catch (error) { throw new BackupError(error instanceof Error ? error.message : `Backup checkpoint ${entry.path} is invalid.`); }
    }
    if (!recovered) throw new BackupError(`Backup contains no complete valid checkpoint for operation ${operationId}.`);
  }
  const assetMetadata = manifest.files.filter((entry) => /^(?:uploads\/(?:backgrounds|garments)|generated\/previews)\/[^/]+\.json$/i.test(entry.path));
  const manifestPaths = new Set(manifest.files.map((entry) => entry.path.toLowerCase()));
  for (const entry of assetMetadata) {
    try {
      const metadata = JSON.parse(await readFile(safePath(payload, entry.path), 'utf8')) as { id?: string; filename?: string; sha256?: string; width?: number; height?: number };
      const directory = path.posix.dirname(entry.path); const expectedId = path.posix.basename(entry.path, '.json');
      if (metadata.id !== expectedId || !metadata.filename || path.posix.basename(metadata.filename) !== metadata.filename) throw new Error('invalid asset identity');
      const relativeBytes = `${directory}/${metadata.filename}`;
      if (!manifestPaths.has(relativeBytes.toLowerCase())) throw new Error('referenced asset bytes are missing');
      const bytesFile = safePath(payload, relativeBytes); const digest = await hashFile(bytesFile);
      if (metadata.sha256 && metadata.sha256 !== digest) throw new Error('recorded asset SHA-256 does not match');
      const image = await sharp(bytesFile).metadata();
      if (!image.width || !image.height || (metadata.width && metadata.width !== image.width) || (metadata.height && metadata.height !== image.height)) throw new Error('image bytes are invalid or dimensions do not match metadata');
    } catch (error) { throw new BackupError(`Backup asset metadata is invalid for ${entry.path}: ${error instanceof Error ? error.message : 'invalid metadata'}.`); }
  }
  for (const entry of manifest.files.filter((candidate) => /^(?:uploads\/(?:backgrounds|garments)|generated\/previews)\/[^/]+\.(?:png|jpg|jpeg)$/i.test(candidate.path))) {
    const id = path.posix.basename(entry.path).replace(/\.[^.]+$/, ''); const metadataPath = `${path.posix.dirname(entry.path)}/${id}.json`;
    if (!manifestPaths.has(metadataPath.toLowerCase())) throw new BackupError(`Backup asset bytes ${entry.path} have no metadata record.`);
  }
  return manifest;
}

export async function createBackup(dataDir: string, backupRoot: string) {
  const destination = path.resolve(backupRoot);
  try { await stat(destination); throw new BackupError('Backup destination already exists.'); } catch (error) { if (error instanceof BackupError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = await acquireDataDirectoryLock(dataDir);
  const staging = `${destination}.creating-${crypto.randomUUID()}`;
  try {
    await mkdir(path.join(staging, 'data'), { recursive: true });
    const relativeFiles = await filesBelow(lock.canonicalDataDir);
    const entries: BackupEntry[] = [];
    for (const relative of relativeFiles) {
      const source = safePath(lock.canonicalDataDir, relative); const target = safePath(path.join(staging, 'data'), relative);
      await mkdir(path.dirname(target), { recursive: true }); await cp(source, target);
      const info = await stat(target); entries.push({ path: relative, size: info.size, sha256: await hashFile(target) });
    }
    await atomicWriteFile(path.join(staging, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files: entries } satisfies BackupManifest, null, 2));
    await validateBackup(staging); await rename(staging, destination); return destination;
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  finally { await lock.release(); }
}

export async function restoreBackup(dataDir: string, backupRoot: string, hooks: RestoreFaultHooks = {}) {
  const manifest = await validateBackup(backupRoot);
  const lock = await acquireDataDirectoryLock(dataDir);
  const parent = path.dirname(lock.canonicalDataDir); const leaf = path.basename(lock.canonicalDataDir);
  const staging = path.join(parent, `.${leaf}.restore-${crypto.randomUUID()}`);
  const previous = path.join(parent, `${leaf}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
  const journal = path.join(parent, `.${leaf}.restore-transaction.json`);
  let movedLive = false;
  try {
    try { await stat(journal); throw new BackupError(`An interrupted restoration journal exists at ${journal}. Preserve the recorded directories and reconcile them before retrying.`); }
    catch (error) { if (error instanceof BackupError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await cp(path.join(path.resolve(backupRoot), 'data'), staging, { recursive: true, errorOnExist: true });
    const stagedRoot = path.join(parent, `.validation-${crypto.randomUUID()}`);
    await mkdir(stagedRoot); await cp(path.join(path.resolve(backupRoot), 'manifest.json'), path.join(stagedRoot, 'manifest.json'));
    await rename(staging, path.join(stagedRoot, 'data')); await validateBackup(stagedRoot); await rename(path.join(stagedRoot, 'data'), staging); await rm(stagedRoot, { recursive: true, force: true });
    await atomicWriteFile(path.join(staging, 'RESTORED_FROM_BACKUP.json'), JSON.stringify({ restoredAt: new Date().toISOString(), backupCreatedAt: manifest.createdAt, previousDataDirectory: previous, requiresShopifyReconciliation: true }, null, 2));
    await atomicWriteFile(journal, JSON.stringify({ version: 1, liveDataDirectory: lock.canonicalDataDir, previousDataDirectory: previous, stagedDataDirectory: staging, requiresShopifyReconciliation: true }, null, 2));
    await rename(lock.canonicalDataDir, previous); movedLive = true; await hooks.afterLiveMoved?.();
    try { await rename(staging, lock.canonicalDataDir); }
    catch (error) { await rename(previous, lock.canonicalDataDir); movedLive = false; throw error; }
    await hooks.afterPromotion?.();
    await rm(journal, { force: true });
    return { previousDataDirectory: previous, requiresShopifyReconciliation: true as const };
  } catch (error) { if (!movedLive) await rm(staging, { recursive: true, force: true }); throw error; }
  finally { await lock.release(); }
}
