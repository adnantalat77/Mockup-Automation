import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const startScript = path.join(repositoryRoot, 'scripts/windows/Start-Mockup-Automation.ps1');
const stopScript = path.join(repositoryRoot, 'scripts/windows/Stop-Mockup-Automation.ps1');
const roots: string[] = [];
const services = new Set<ChildProcess>();

async function fixture(options: { withConfig?: boolean; publishing?: string; token?: string; allowlist?: string; shutdownFails?: boolean } = {}) {
  const { withConfig = true, publishing = 'true', token = 'a'.repeat(32), allowlist = 'gid://shopify/Product/123', shutdownFails = false } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mockup launcher ')); roots.push(root);
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'apps/api/dist'), { recursive: true });
  await mkdir(path.join(root, 'apps/web/dist'), { recursive: true });
  await writeFile(path.join(root, 'apps/web/dist/index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(path.join(root, 'apps/api/dist/server.js'), `
    const http = require('node:http');
    const fs = require('node:fs');
    const instanceToken = process.env.MOCKUP_INSTANCE_TOKEN; const shutdownToken = process.env.MOCKUP_SHUTDOWN_TOKEN; const startupId = process.env.MOCKUP_STARTUP_ID;
    const server = http.createServer((request, response) => {
      if (request.url === '/api/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok', application: 'mockup-automation', phase: 4 })); return; }
      if (request.url === '/' && request.method === 'GET') { response.setHeader('content-type', 'text/html'); response.end('<main id="root">dashboard</main>'); return; }
      if (request.url === '/api/publishing/status' && request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ enabled: process.env.SHOPIFY_PUBLISHING_ENABLED === 'true' })); return; }
      if (request.url === '/api/publishing/publish' && request.method === 'POST' && process.env.SHOPIFY_PUBLISHING_ENABLED !== 'true') { response.statusCode = 403; response.end(); return; }
      if (request.url === '/api/runtime/identity' && request.method === 'POST') {
        if (request.headers['x-local-instance-token'] !== instanceToken) { response.statusCode = 401; response.end(); return; }
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ application: 'mockup-automation', phase: 4, startupId, pid: process.pid, appRoot: process.cwd(), dataDir: fs.realpathSync(process.env.DATA_DIR) })); return;
      }
      if (request.url === '/api/runtime/shutdown' && request.method === 'POST') {
        if (request.headers['x-local-shutdown-token'] !== shutdownToken) { response.statusCode = 401; response.end(); return; }
        if (${shutdownFails ? 'true' : 'false'}) { response.statusCode = 500; response.end(); return; }
        response.setHeader('content-type', 'application/json'); response.statusCode = 202; response.end(JSON.stringify({ status: 'shutting_down', startupId })); server.close(() => process.exit(0)); return;
      }
      response.statusCode = 404; response.end();
    });
    server.listen(3001, '127.0.0.1');
  `);
  if (withConfig) await writeFile(path.join(root, '.env'), [
    'SHOPIFY_SHOP_DOMAIN=fixture.myshopify.com', 'SHOPIFY_CLIENT_ID=fixture-client', 'SHOPIFY_CLIENT_SECRET=fixture-secret', 'SHOPIFY_API_VERSION=2026-10',
    `SHOPIFY_PUBLISHING_ENABLED=${publishing}`, `SHOPIFY_PUBLISHING_AUTH_TOKEN=${token}`, `SHOPIFY_PUBLISH_PRODUCT_IDS=${allowlist}`,
    'DATA_DIR=./data', 'WEB_ORIGIN=http://127.0.0.1:3001'
  ].join('\n'));
  return root;
}

async function powershell(script: string, args: string[] = []) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { timeout: 25_000, windowsHide: true });
}

afterEach(async () => {
  for (const root of roots) {
    try { await powershell(stopScript, ['-AppRoot', root]); } catch { /* preserve failure evidence for the assertion; process cleanup follows */ }
    try {
      const state = JSON.parse(await readFile(path.join(root, 'logs/runtime.json'), 'utf8')) as { pid?: number };
      if (state.pid && state.pid !== process.pid) {
        process.kill(state.pid);
        for (let attempt = 0; attempt < 30; attempt += 1) { try { process.kill(state.pid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { break; } }
      }
    } catch { /* already stopped */ }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  roots.length = 0;
  for (const service of services) if (service.exitCode === null) service.kill();
  services.clear();
});

describe.skipIf(process.platform !== 'win32')('Windows production launcher', () => {
  it('fails clearly when configuration is missing', async () => {
    const root = await fixture({ withConfig: false });
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Configuration is missing/) });
  });

  it('fails clearly when the Node runtime is missing', async () => {
    const root = await fixture();
    await expect(powershell(startScript, ['-AppRoot', root, '-NodeCommand', '__missing_node__', '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Node\.js 20\.19 or newer is required/) });
  });

  it('starts read-only without a publishing token or allowlist and leaves mutation endpoints disabled', async () => {
    const root = await fixture({ publishing: 'false', token: '', allowlist: '' });
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).resolves.toMatchObject({ stdout: expect.stringMatching(/started/) });
    expect((await fetch('http://127.0.0.1:3001/')).status).toBe(200);
    await expect(fetch('http://127.0.0.1:3001/api/publishing/status').then((response) => response.json())).resolves.toMatchObject({ enabled: false });
    expect((await fetch('http://127.0.0.1:3001/api/publishing/publish', { method: 'POST' })).status).toBe(403);
  }, 30_000);

  it.each([
    ['invalid flag', { publishing: 'yes' }, /must be exactly true or false/],
    ['missing enabled token', { publishing: 'true', token: '' }, /AUTH_TOKEN/],
    ['invalid enabled allowlist', { publishing: 'true', allowlist: 'not-a-gid' }, /PRODUCT_IDS/]
  ])('rejects %s', async (_name, options, diagnostic) => {
    const root = await fixture(options);
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(diagnostic) });
  });

  it('starts production health, reuses the running instance, rejects a bad shutdown token, and stops gracefully', async () => {
    const root = await fixture();
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).resolves.toMatchObject({ stdout: expect.stringMatching(/started/) });
    const firstState = JSON.parse(await readFile(path.join(root, 'logs/runtime.json'), 'utf8')) as { pid: number; shutdownToken: string };
    expect((await fetch('http://127.0.0.1:3001/api/health')).status).toBe(200);
    expect((await fetch('http://127.0.0.1:3001/api/runtime/identity', { method: 'POST' })).status).toBe(401);
    await expect(fetch('http://127.0.0.1:3001/api/runtime/shutdown', { method: 'POST', headers: { 'X-Local-Shutdown-Token': 'wrong' } })).resolves.toMatchObject({ status: 401 });
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).resolves.toMatchObject({ stdout: expect.stringMatching(/already running/) });
    const secondState = JSON.parse(await readFile(path.join(root, 'logs/runtime.json'), 'utf8')) as { pid: number };
    expect(secondState.pid).toBe(firstState.pid);
    await expect(powershell(stopScript, ['-AppRoot', root])).resolves.toMatchObject({ stdout: expect.stringMatching(/stopped gracefully/) });
    await expect(fetch('http://127.0.0.1:3001/api/health')).rejects.toThrow();
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).resolves.toMatchObject({ stdout: expect.stringMatching(/started/) });
    await expect(powershell(stopScript, ['-AppRoot', root])).resolves.toMatchObject({ stdout: expect.stringMatching(/stopped gracefully/) });
  }, 30_000);

  it('rejects wrong capabilities, missing records, and mismatched installation or data identities', async () => {
    const root = await fixture(); const statePath = path.join(root, 'logs/runtime.json');
    await powershell(startScript, ['-AppRoot', root, '-NoBrowser']);
    const original = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    for (const change of [
      { instanceToken: 'b'.repeat(64) },
      { appRoot: `${root}-other` },
      { dataDir: `${path.join(root, 'data')}-other` },
      { pid: process.pid }
    ]) {
      await writeFile(statePath, JSON.stringify({ ...original, ...change }));
      await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toBeTruthy();
    }
    await writeFile(statePath, JSON.stringify(original));
    await rm(statePath);
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/no runtime ownership record/) });
    await writeFile(statePath, JSON.stringify(original));
  }, 45_000);

  it('fails closed for a corrupted record and for a live recorded PID with no identity service', async () => {
    const root = await fixture(); const statePath = path.join(root, 'logs/runtime.json'); await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, '{broken');
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/malformed/) });
    await writeFile(statePath, JSON.stringify({ schemaVersion: 2, pid: process.pid }));
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/incomplete/) });
    await writeFile(statePath, JSON.stringify({ schemaVersion: 2, pid: process.pid, port: 3001, appRoot: root, dataDir: path.join(root, 'data'), startupId: 'pid-reuse', instanceToken: 'i'.repeat(64), shutdownToken: 's'.repeat(64) }));
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/recorded process is alive/) });
  }, 30_000);

  it('removes a dead stale record, coordinates concurrent launchers, and creates only one process', async () => {
    const root = await fixture(); const statePath = path.join(root, 'logs/runtime.json'); await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ schemaVersion: 2, pid: 2147483000, port: 3001, appRoot: root, dataDir: path.join(root, 'data'), startupId: 'stale', instanceToken: 'i'.repeat(64), shutdownToken: 's'.repeat(64) }));
    const results = await Promise.all([powershell(startScript, ['-AppRoot', root, '-NoBrowser']), powershell(startScript, ['-AppRoot', root, '-NoBrowser'])]);
    expect(results.some((result) => /started/.test(result.stdout))).toBe(true); expect(results.some((result) => /authenticated/.test(result.stdout))).toBe(true);
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { pid: number; status: string };
    expect(state.status).toBe('ready'); expect(state.pid).toBeGreaterThan(0);
  }, 45_000);

  it('rejects a health-compatible fake service without an authenticated runtime record', async () => {
    const root = await fixture();
    const service = spawn(process.execPath, ['-e', `require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({status:'ok',application:'mockup-automation',phase:4}))}).listen(3001,'127.0.0.1')`], { stdio: 'ignore' });
    services.add(service);
    for (let attempt = 0; attempt < 30; attempt += 1) { try { await fetch('http://127.0.0.1:3001/api/health'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/no runtime ownership record/) });
  });

  it('preserves an active process and runtime record when graceful shutdown fails', async () => {
    const root = await fixture({ shutdownFails: true }); const statePath = path.join(root, 'logs/runtime.json');
    await powershell(startScript, ['-AppRoot', root, '-NoBrowser']); const state = JSON.parse(await readFile(statePath, 'utf8')) as { pid: number };
    await expect(powershell(stopScript, ['-AppRoot', root])).rejects.toBeTruthy();
    expect(await readFile(statePath, 'utf8')).toBeTruthy(); expect(process.kill(state.pid, 0)).toBe(true);
  }, 30_000);

  it('cleans a failed pre-readiness startup without trusting it as an instance', async () => {
    const root = await fixture(); await writeFile(path.join(root, 'apps/api/dist/server.js'), 'process.exit(1);');
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/did not become ready/) });
    await expect(readFile(path.join(root, 'logs/runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});
