import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, isPublishingOriginAllowed } from './app.js';
import { analyzeTransparency, compositePreview, hasTransparentPixels } from './services/images.js';

let dataDir: string;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'mockup-api-')); app = await createApp({ dataDir, maxUploadBytes: 1024 * 1024 }); });
afterEach(() => {});

const transparentPng = () => sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 220, g: 20, b: 20, alpha: 0.5 } } }).png().toBuffer();
const opaquePng = () => sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();
const backgroundJpeg = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#287a45' } }).jpeg().toBuffer();
const solidBackground = (width: number, height: number, color = '#ffffff') => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

async function cutoutGarment(width = 40, height = 20) {
  const redRectangle = await sharp({ create: { width: width / 2, height: height / 2, channels: 4, background: { r: 220, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: redRectangle, gravity: 'center' }]).png().toBuffer();
}

describe('image validation', () => {
  it('detects actual alpha values', async () => {
    expect(await hasTransparentPixels(await transparentPng())).toBe(true);
    expect(await hasTransparentPixels(await opaquePng())).toBe(false);
  });

  it('rejects insignificant edge transparency but accepts antialiased transparency', async () => {
    const almostOpaqueRaw = Buffer.alloc(40 * 40 * 4, 255);
    almostOpaqueRaw[3] = 0;
    almostOpaqueRaw[7] = 249;
    const almostOpaque = await sharp(almostOpaqueRaw, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();
    const antialiasedRaw = Buffer.alloc(40 * 40 * 4, 255);
    for (let pixel = 0; pixel < 20; pixel += 1) antialiasedRaw[pixel * 4 + 3] = 128;
    const antialiased = await sharp(antialiasedRaw, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer();

    expect((await analyzeTransparency(almostOpaque)).isMeaningfullyTransparent).toBe(false);
    expect((await analyzeTransparency(antialiased)).isMeaningfullyTransparent).toBe(true);
  });

  it('rejects opaque garment PNGs', async () => {
    const response = await request(app).post('/api/garments').attach('image', await opaquePng(), 'shirt.png');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/opaque/i);
  });

  it('validates content independently of the extension', async () => {
    const valid = await request(app).post('/api/backgrounds').attach('image', await backgroundJpeg(), 'scene.txt');
    expect(valid.status).toBe(201);
    const invalid = await request(app).post('/api/backgrounds').attach('image', Buffer.from('not an image'), 'fake.png');
    expect(invalid.status).toBe(400);
  });

  it('returns a graceful size-limit error', async () => {
    const response = await request(app).post('/api/backgrounds').attach('image', Buffer.alloc(1024 * 1024 + 1), 'large.png');
    expect(response.status).toBe(413);
    expect(response.body.error).toMatch(/limit/i);
  });
});

describe('compositing', () => {
  it('preserves inputs and outputs the background dimensions', async () => {
    const background = await backgroundJpeg();
    const garment = await transparentPng();
    const backgroundCopy = Buffer.from(background);
    const garmentCopy = Buffer.from(garment);
    const output = await compositePreview(background, garment);
    expect(background.equals(backgroundCopy)).toBe(true);
    expect(garment.equals(garmentCopy)).toBe(true);
    const metadata = await sharp(output).metadata();
    expect([metadata.width, metadata.height, metadata.format]).toEqual([40, 30, 'png']);
    const center = await sharp(output).extract({ left: 20, top: 15, width: 1, height: 1 }).raw().toBuffer();
    expect(center[0]).toBeGreaterThan(center[1]);
  });

  it.each([
    ['landscape', 80, 40],
    ['portrait', 40, 80]
  ])('preserves %s background dimensions and aspect ratio', async (_name, width, height) => {
    const output = await compositePreview(await solidBackground(width, height), await cutoutGarment());
    const metadata = await sharp(output).metadata();
    expect([metadata.width, metadata.height]).toEqual([width, height]);
    expect(metadata.width! / metadata.height!).toBe(width / height);
  });

  it('normalizes EXIF-rotated JPEG dimensions before compositing', async () => {
    const encodedLandscape = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#ffffff' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const output = await compositePreview(encodedLandscape, await cutoutGarment());
    const metadata = await sharp(output).metadata();
    expect([metadata.width, metadata.height]).toEqual([40, 80]);
  });

  it('preserves garment colors and uniform proportions when scaling', async () => {
    const output = await compositePreview(await solidBackground(30, 30), await cutoutGarment(40, 20));
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const colored: Array<[number, number]> = [];
    for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] > 180 && data[offset + 1] < 80 && data[offset + 2] < 80) colored.push([x, y]);
    }
    const xs = colored.map(([x]) => x); const ys = colored.map(([, y]) => y);
    const renderedWidth = Math.max(...xs) - Math.min(...xs) + 1;
    const renderedHeight = Math.max(...ys) - Math.min(...ys) + 1;
    expect(renderedWidth / renderedHeight).toBeCloseTo(2, 0);
    const centerOffset = (15 * info.width + 15) * info.channels;
    expect(Array.from(data.subarray(centerOffset, centerOffset + 3))).toEqual([220, 20, 20]);
  });

  it('rejects malformed UUID-like asset IDs', async () => {
    const response = await request(app).get('/api/assets/garment/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not found/i);
  });

  it('stores source files unchanged when generating through the API', async () => {
    const background = await backgroundJpeg();
    const garment = await transparentPng();
    const bg = await request(app).post('/api/backgrounds').attach('image', background, 'scene.jpg');
    const shirt = await request(app).post('/api/garments').attach('image', garment, 'shirt.png');
    const generated = await request(app).post('/api/previews').send({ backgroundId: bg.body.id, garmentId: shirt.body.id });
    expect(generated.status).toBe(201);
    const garmentFiles = (await readdir(path.join(dataDir, 'uploads', 'garments'))).filter((name) => name.endsWith('.png'));
    expect((await readFile(path.join(dataDir, 'uploads', 'garments', garmentFiles[0]))).equals(garment)).toBe(true);
  });
});

describe('publishing authorization', () => {
  it('allows an authenticated read-only history request without Origin but still requires Origin for mutations', () => {
    expect(isPublishingOriginAllowed(undefined, 'http://127.0.0.1:3000', false)).toBe(true);
    expect(isPublishingOriginAllowed(undefined, 'http://127.0.0.1:3000', true)).toBe(false);
    expect(isPublishingOriginAllowed('https://attacker.example', 'http://127.0.0.1:3000', false)).toBe(false);
  });

  it('rejects publication while the server feature flag is disabled', async () => {
    const response = await request(app).post('/api/publishing/publish').set('Origin', 'http://127.0.0.1:3000').set('X-Publish-Authorization', 'not-authorized').send({ batchId: '00000000-0000-4000-8000-000000000000', confirm: 'PUBLISH' });
    expect(response.status).toBe(403);
  });

  it('protects rollback finalization verification and mutation routes while publishing is disabled', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const headers = { Origin: 'http://127.0.0.1:3000', 'X-Publish-Authorization': 'not-authorized' };
    const verification = await request(app).post(`/api/publishing/${id}/rollback-finalization/validate`).set(headers).send({});
    const finalization = await request(app).post(`/api/publishing/${id}/rollback-finalization`).set(headers).send({ confirm: `FINALIZE ${id} FILES RETAINED` });
    expect(verification.status).toBe(403); expect(finalization.status).toBe(403);
    expect(isPublishingOriginAllowed('https://attacker.example', 'http://127.0.0.1:3000', true)).toBe(false);
  });

  it('protects restoration status, validation, and clearance routes while publishing is disabled', async () => {
    const headers = { Origin: 'http://127.0.0.1:3000', 'X-Publish-Authorization': 'not-authorized' };
    expect((await request(app).get('/api/publishing/restoration/status').set('X-Publish-Authorization', 'not-authorized')).status).toBe(403);
    expect((await request(app).post('/api/publishing/restoration/validate').set(headers).send({})).status).toBe(403);
    expect((await request(app).post('/api/publishing/restoration/clear').set(headers).send({ confirm: 'CLEAR RESTORATION invalid' })).status).toBe(403);
  });
});

describe('production frontend serving', () => {
  it('serves the built dashboard and client routes while preserving API health', async () => {
    const webDistDir = await mkdtemp(path.join(tmpdir(), 'mockup-web-dist-'));
    await writeFile(path.join(webDistDir, 'index.html'), '<!doctype html><title>Mockup Automation production</title>');
    const productionApp = await createApp({ dataDir: await mkdtemp(path.join(tmpdir(), 'mockup-production-data-')), maxUploadBytes: 1024 * 1024, webDistDir });
    expect((await request(productionApp).get('/')).text).toContain('Mockup Automation production');
    expect((await request(productionApp).get('/publication-history')).text).toContain('Mockup Automation production');
    await expect(request(productionApp).get('/api/health')).resolves.toMatchObject({ status: 200, body: { status: 'ok' } });
    expect((await request(productionApp).get('/api/not-a-route')).status).toBe(404);
  });

  it('fails startup when the configured production frontend build is missing', async () => {
    await expect(createApp({ dataDir: await mkdtemp(path.join(tmpdir(), 'mockup-production-data-')), webDistDir: path.join(tmpdir(), 'missing-web-build') })).rejects.toThrow(/Production frontend build is missing/);
  });
});
