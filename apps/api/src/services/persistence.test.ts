import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import { BackupError, createBackup, restoreBackup, validateBackup } from './backup.js';
import { PersistenceError, recoverInterruptedReplacements, type AtomicWriter } from './persistence.js';

const roots: string[] = [];
async function temporary(label: string) { const root = await mkdtemp(path.join(os.tmpdir(), label)); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('durable local persistence', () => {
  it.each(['ENOSPC', 'EACCES', 'EPERM'])('does not return an asset reference after %s metadata failure', async (code) => {
    const root = await temporary('asset-failure-'); let calls = 0;
    const writer: AtomicWriter = async (destination, data) => {
      calls += 1; if (calls === 2) throw new PersistenceError('injected failure', code);
      await writeFile(destination, data, { flag: 'wx' });
    };
    const store = new AssetStore(root, writer); await store.init();
    await expect(store.save('background', Buffer.from('bytes'), 'png', { originalName: 'x.png', width: 1, height: 1 })).rejects.toMatchObject({ code });
    const files = await readdir(path.join(root, 'uploads', 'backgrounds'));
    expect(files.some((file) => file.endsWith('.json'))).toBe(false);
  });

  it('detects missing and hash-mismatched asset bytes', async () => {
    const root = await temporary('asset-integrity-'); const store = new AssetStore(root); await store.init();
    const asset = await store.save('background', Buffer.from('original'), 'png', { originalName: 'x.png', width: 1, height: 1 });
    await writeFile(path.join(root, 'uploads', 'backgrounds', `${asset.id}.png`), 'changed');
    await expect(store.bytes('background', asset.id)).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    await rm(path.join(root, 'uploads', 'backgrounds', `${asset.id}.png`));
    await expect(store.bytes('background', asset.id)).rejects.toThrow(/missing or unreadable/);
  });

  it('fails recovery instead of silently discarding corrupt batch metadata', async () => {
    const root = await temporary('batch-corrupt-'); await writeFile(path.join(root, 'placeholder'), 'x');
    const assets = new AssetStore(root); await assets.init();
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(root, 'batches'), { recursive: true }));
    await writeFile(path.join(root, 'batches', '11111111-1111-4111-8111-111111111111.json'), '{"status":"completed"}');
    const batches = new BatchService(root, assets, { getProduct: vi.fn(), downloadImage: vi.fn() } as any);
    await expect(batches.init()).rejects.toThrow(/Batch recovery failed/);
  });

  it('restores the preserved prior batch record after an interrupted Windows replacement', async () => {
    const root = await temporary('batch-replacement-'); const folder = path.join(root, 'batches');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(folder));
    const destination = '11111111-1111-4111-8111-111111111111.json';
    await writeFile(path.join(folder, `.${destination}.11111111-1111-4111-8111-111111111111.replace-backup`), '{"preserved":true}');
    await recoverInterruptedReplacements(folder);
    expect(await readFile(path.join(folder, destination), 'utf8')).toBe('{"preserved":true}');
  });
});

describe('offline backup validation and restoration', () => {
  it('creates, validates, and explicitly restores while preserving the prior live directory', async () => {
    const parent = await temporary('backup-flow-'); const live = path.join(parent, 'live data'); const backup = path.join(parent, 'backup');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(live)); await writeFile(path.join(live, 'state.json'), '{"version":1}');
    await createBackup(live, backup); await expect(validateBackup(backup)).resolves.toMatchObject({ version: 1 });
    await writeFile(path.join(live, 'state.json'), '{"version":2}');
    const restored = await restoreBackup(live, backup);
    expect(await readFile(path.join(live, 'state.json'), 'utf8')).toBe('{"version":1}');
    expect(await readFile(path.join(restored.previousDataDirectory, 'state.json'), 'utf8')).toBe('{"version":2}');
    expect(JSON.parse(await readFile(path.join(live, 'RESTORED_FROM_BACKUP.json'), 'utf8'))).toMatchObject({ requiresShopifyReconciliation: true });
  });

  it('rejects integrity mismatch and path traversal before replacing live data', async () => {
    const parent = await temporary('backup-invalid-'); const live = path.join(parent, 'live'); const backup = path.join(parent, 'backup');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(live)); await writeFile(path.join(live, 'state.json'), 'live'); await createBackup(live, backup);
    await writeFile(path.join(backup, 'data', 'state.json'), 'tampered');
    await expect(restoreBackup(live, backup)).rejects.toBeInstanceOf(BackupError);
    expect(await readFile(path.join(live, 'state.json'), 'utf8')).toBe('live');
    const manifest = JSON.parse(await readFile(path.join(backup, 'manifest.json'), 'utf8')); manifest.files[0].path = '../escape';
    await writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
    await expect(validateBackup(backup)).rejects.toBeInstanceOf(BackupError);
  });

  it('rejects case-colliding manifest paths and missing backup assets', async () => {
    const parent = await temporary('backup-collision-'); const live = path.join(parent, 'live'); const backup = path.join(parent, 'backup');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(live)); await writeFile(path.join(live, 'State.json'), 'live'); await createBackup(live, backup);
    const manifestFile = path.join(backup, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toLowerCase() }); await writeFile(manifestFile, JSON.stringify(manifest));
    await expect(validateBackup(backup)).rejects.toThrow(/case-colliding/);
    manifest.files.pop(); await writeFile(manifestFile, JSON.stringify(manifest)); await rm(path.join(backup, 'data', 'State.json'));
    await expect(validateBackup(backup)).rejects.toThrow(/file set/);
  });

  it('rejects symlink or junction content instead of following it into a backup', async () => {
    const parent = await temporary('backup-link-'); const live = path.join(parent, 'live'); const target = path.join(parent, 'outside');
    const { mkdir, symlink } = await import('node:fs/promises'); await mkdir(live); await mkdir(target); await writeFile(path.join(target, 'secret.txt'), 'outside');
    await symlink(target, path.join(live, 'linked'), 'junction');
    await expect(createBackup(live, path.join(parent, 'backup'))).rejects.toThrow(/link or reparse point/);
  });

  it('leaves an interrupted pre-promotion restore journal with the previous live data recoverable', async () => {
    const parent = await temporary('restore-pre-promotion-'); const live = path.join(parent, 'live'); const backup = path.join(parent, 'backup');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(live)); await writeFile(path.join(live, 'state.json'), 'old'); await createBackup(live, backup); await writeFile(path.join(live, 'state.json'), 'new');
    await expect(restoreBackup(live, backup, { afterLiveMoved: () => { throw new Error('simulated crash'); } })).rejects.toThrow('simulated crash');
    const journal = JSON.parse(await readFile(path.join(parent, '.live.restore-transaction.json'), 'utf8'));
    expect(await readFile(path.join(journal.previousDataDirectory, 'state.json'), 'utf8')).toBe('new');
    expect(await readFile(path.join(journal.stagedDataDirectory, 'RESTORED_FROM_BACKUP.json'), 'utf8')).toContain('requiresShopifyReconciliation');
  });

  it('promotes only a restored tree that already contains the reconciliation marker', async () => {
    const parent = await temporary('restore-post-promotion-'); const live = path.join(parent, 'live'); const backup = path.join(parent, 'backup');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(live)); await writeFile(path.join(live, 'state.json'), 'old'); await createBackup(live, backup); await writeFile(path.join(live, 'state.json'), 'new');
    await expect(restoreBackup(live, backup, { afterPromotion: () => { throw new Error('simulated post-promotion crash'); } })).rejects.toThrow('simulated post-promotion crash');
    expect(JSON.parse(await readFile(path.join(live, 'RESTORED_FROM_BACKUP.json'), 'utf8'))).toMatchObject({ requiresShopifyReconciliation: true });
    expect(await readFile(path.join(live, 'state.json'), 'utf8')).toBe('old');
  });

  it('refuses backup or restoration while another process owns the data directory', async () => {
    const parent = await temporary('backup-lock-'); const live = path.join(parent, 'live'); const backup = path.join(parent, 'backup');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(live)); await writeFile(path.join(live, 'state.json'), 'live'); await createBackup(live, backup);
    const { acquireDataDirectoryLock } = await import('./instance-lock.js'); const lock = await acquireDataDirectoryLock(live);
    await expect(restoreBackup(live, backup)).rejects.toThrow(/already running/); await lock.release();
  });
});
