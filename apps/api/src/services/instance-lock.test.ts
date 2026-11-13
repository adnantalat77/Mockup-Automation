import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { startApi } from '../runtime.js';
import { acquireDataDirectoryLock, canonicalizeDataDirectory, normalizeCanonicalPath } from './instance-lock.js';

const fixture = path.resolve(import.meta.dirname, '../test-fixtures/instance-lock-child.ts');
const tsxLoader = import.meta.resolve('tsx');
const children = new Set<ChildProcess>();
const temporaryDirectories: string[] = [];

type ChildResult = { type: 'acquired'; canonicalDataDir: string } | { type: 'rejected'; message: string };

async function tempDir(label = 'mockup-lock-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

function launch(dataDir: string, marker = '', cwd?: string) {
  const child = fork(fixture, [dataDir, marker], { cwd, execArgv: ['--import', tsxLoader], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const result = new Promise<ChildResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child lock result timed out.')), 10_000);
    child.once('message', (message) => { clearTimeout(timer); resolve(message as ChildResult); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return { child, result };
}

async function stop(child: ChildProcess, graceful = true) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (graceful && child.connected) child.send('release');
  else child.kill();
  await exited;
}

afterEach(async () => {
  await Promise.all([...children].map((child) => stop(child, false)));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('cross-process data-directory ownership', () => {
  it('allows one independent process and rejects a second without mutable initialization', async () => {
    const directory = await tempDir();
    const marker = path.join(directory, 'initialized.txt');
    const first = launch(directory, marker);
    expect((await first.result).type).toBe('acquired');
    const second = launch(`${directory}${path.sep}`, marker);
    const rejected = await second.result;
    expect(rejected).toMatchObject({ type: 'rejected' });
    expect((rejected as Extract<ChildResult, { type: 'rejected' }>).message).toContain('already running against this data directory');
    expect((await readFile(marker, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1);
    await stop(first.child);
  });

  it('releases ownership after normal shutdown', async () => {
    const directory = await tempDir();
    const first = launch(directory);
    await first.result;
    await stop(first.child);
    const restarted = launch(directory);
    expect((await restarted.result).type).toBe('acquired');
    await stop(restarted.child);
  });

  it('releases the OS-owned lock after forced termination and permits restart', async () => {
    const directory = await tempDir();
    const first = launch(directory);
    await first.result;
    await stop(first.child, false);
    const restarted = launch(directory);
    expect((await restarted.result).type).toBe('acquired');
    await stop(restarted.child);
  });

  it('treats relative, absolute, spaced, and trailing-separator paths as the same directory', async () => {
    const parent = await tempDir('mockup lock parent ');
    const directory = path.join(parent, 'data with spaces');
    const first = launch(path.relative(parent, directory), '', parent);
    expect((await first.result).type).toBe('acquired');
    const second = launch(`${path.resolve(directory)}${path.sep}`);
    expect((await second.result).type).toBe('rejected');
    await stop(first.child);
  });

  it('ignores stale metadata because ownership is an OS handle, not a PID file', async () => {
    const directory = await tempDir();
    const stale = path.join(directory, '.mockup-automation.lock');
    await writeFile(stale, JSON.stringify({ pid: 1, stale: true }));
    const child = launch(directory);
    expect((await child.result).type).toBe('acquired');
    expect(await readFile(stale, 'utf8')).toContain('stale');
    await stop(child.child);
  });

  it('selects exactly one winner for simultaneous independent acquisitions', async () => {
    const directory = await tempDir();
    const attempts = Array.from({ length: 6 }, () => launch(directory));
    const results = await Promise.all(attempts.map((attempt) => attempt.result));
    expect(results.filter((result) => result.type === 'acquired')).toHaveLength(1);
    expect(results.filter((result) => result.type === 'rejected')).toHaveLength(5);
  });
});

describe('lock integration and identity', () => {
  it('normalizes Windows path case and trailing separators', () => {
    expect(normalizeCanonicalPath('C:\\Users\\ADNAN\\Data\\', 'win32')).toBe('c:\\users\\adnan\\data');
  });

  it('resolves a newly created directory to a stable real path', async () => {
    const parent = await tempDir();
    const directory = path.join(parent, 'new data');
    const first = await canonicalizeDataDirectory(directory);
    const second = await canonicalizeDataDirectory(path.join(parent, '.', 'new data'));
    expect(second.identity).toBe(first.identity);
  });

  it('releases ownership when mutable application initialization fails', async () => {
    const directory = await tempDir();
    await expect(startApi({ dataDir: directory }, {
      createApplication: async () => { throw new Error('simulated initialization failure'); }
    })).rejects.toThrow('simulated initialization failure');
    const lock = await acquireDataDirectoryLock(directory);
    await lock.release();
  });

  it('blocks startup before mutable initialization when an interrupted restore journal exists', async () => {
    const directory = await tempDir(); const marker = path.join(path.dirname(directory), `.${path.basename(directory)}.restore-transaction.json`);
    await writeFile(marker, '{}'); let initialized = false;
    await expect(startApi({ dataDir: directory }, { createApplication: async () => { initialized = true; return express(); }, listenPort: 0 })).rejects.toThrow(/interrupted restoration journal/);
    expect(initialized).toBe(false); await rm(marker);
    const lock = await acquireDataDirectoryLock(directory); await lock.release();
  });

  it('retains ownership after a failed HTTP shutdown and permits a safe retry', async () => {
    const directory = await tempDir();
    const runtime = await startApi({ dataDir: directory }, { createApplication: async () => express(), listenPort: 0 });
    const close = runtime.server.close.bind(runtime.server);
    runtime.server.close = ((callback?: (error?: Error) => void) => {
      callback?.(new Error('simulated close failure'));
      return runtime.server;
    }) as typeof runtime.server.close;

    await expect(runtime.stop()).rejects.toThrow('simulated close failure');
    await expect(acquireDataDirectoryLock(directory)).rejects.toThrow('already running against this data directory');

    runtime.server.close = close as typeof runtime.server.close;
    await runtime.stop();
    const nextOwner = await acquireDataDirectoryLock(directory);
    await nextOwner.release();
  });

  it('coalesces concurrent shutdown calls and retains ownership while a request is pending', async () => {
    const directory = await tempDir();
    let markEntered!: () => void;
    let finishRequest!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const pending = new Promise<void>((resolve) => { finishRequest = resolve; });
    const app = express();
    app.get('/pending', async (_request, response) => { markEntered(); await pending; response.sendStatus(204); });
    const runtime = await startApi({ dataDir: directory }, { createApplication: async () => app, listenPort: 0 });
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    const request = fetch(`http://127.0.0.1:${address.port}/pending`);
    await entered;

    const close = runtime.server.close.bind(runtime.server);
    let closeCalls = 0;
    runtime.server.close = ((...args: Parameters<typeof runtime.server.close>) => { closeCalls += 1; return close(...args); }) as typeof runtime.server.close;
    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    await expect(acquireDataDirectoryLock(directory)).rejects.toThrow('already running against this data directory');
    expect(closeCalls).toBe(1);

    finishRequest();
    expect((await request).status).toBe(204);
    await Promise.all([firstStop, secondStop]);
    const nextOwner = await acquireDataDirectoryLock(directory);
    await nextOwner.release();
  });
});
