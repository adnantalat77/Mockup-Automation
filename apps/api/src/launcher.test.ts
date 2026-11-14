import { execFile } from 'node:child_process';
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

async function fixture(withConfig = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mockup launcher ')); roots.push(root);
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, 'apps/api/dist'), { recursive: true });
  await mkdir(path.join(root, 'apps/web/dist'), { recursive: true });
  await writeFile(path.join(root, 'apps/web/dist/index.html'), '<!doctype html><title>fixture</title>');
  await writeFile(path.join(root, 'apps/api/dist/server.js'), `
    const http = require('node:http');
    const token = process.env.MOCKUP_SHUTDOWN_TOKEN;
    const server = http.createServer((request, response) => {
      if (request.url === '/api/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok', application: 'mockup-automation', phase: 4 })); return; }
      if (request.url === '/api/runtime/shutdown' && request.method === 'POST') {
        if (request.headers['x-local-shutdown-token'] !== token) { response.statusCode = 401; response.end(); return; }
        response.statusCode = 202; response.end(); server.close(() => process.exit(0)); return;
      }
      response.statusCode = 404; response.end();
    });
    server.listen(3001, '127.0.0.1');
  `);
  if (withConfig) await writeFile(path.join(root, '.env'), [
    'SHOPIFY_SHOP_DOMAIN=fixture.myshopify.com', 'SHOPIFY_CLIENT_ID=fixture-client', 'SHOPIFY_CLIENT_SECRET=fixture-secret', 'SHOPIFY_API_VERSION=2026-10',
    'SHOPIFY_PUBLISHING_ENABLED=true', `SHOPIFY_PUBLISHING_AUTH_TOKEN=${'a'.repeat(32)}`, 'SHOPIFY_PUBLISH_PRODUCT_IDS=gid://shopify/Product/123',
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
      if (state.pid) process.kill(state.pid);
    } catch { /* already stopped */ }
    await rm(root, { recursive: true, force: true });
  }
  roots.length = 0;
});

describe.skipIf(process.platform !== 'win32')('Windows production launcher', () => {
  it('fails clearly when configuration is missing', async () => {
    const root = await fixture(false);
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Configuration is missing/) });
  });

  it('fails clearly when the Node runtime is missing', async () => {
    const root = await fixture();
    await expect(powershell(startScript, ['-AppRoot', root, '-NodeCommand', '__missing_node__', '-NoBrowser'])).rejects.toMatchObject({ stderr: expect.stringMatching(/Node\.js 20\.19 or newer is required/) });
  });

  it('starts production health, reuses the running instance, rejects a bad shutdown token, and stops gracefully', async () => {
    const root = await fixture();
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).resolves.toMatchObject({ stdout: expect.stringMatching(/started/) });
    const firstState = JSON.parse(await readFile(path.join(root, 'logs/runtime.json'), 'utf8')) as { pid: number; shutdownToken: string };
    expect((await fetch('http://127.0.0.1:3001/api/health')).status).toBe(200);
    await expect(fetch('http://127.0.0.1:3001/api/runtime/shutdown', { method: 'POST', headers: { 'X-Local-Shutdown-Token': 'wrong' } })).resolves.toMatchObject({ status: 401 });
    await expect(powershell(startScript, ['-AppRoot', root, '-NoBrowser'])).resolves.toMatchObject({ stdout: expect.stringMatching(/already running/) });
    const secondState = JSON.parse(await readFile(path.join(root, 'logs/runtime.json'), 'utf8')) as { pid: number };
    expect(secondState.pid).toBe(firstState.pid);
    await expect(powershell(stopScript, ['-AppRoot', root])).resolves.toMatchObject({ stdout: expect.stringMatching(/stopped gracefully/) });
    await expect(fetch('http://127.0.0.1:3001/api/health')).rejects.toThrow();
  }, 30_000);
});
