import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { compositePreview, hasTransparentPixels } from './services/images.js';

let dataDir: string;
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'mockup-api-')); app = await createApp({ dataDir, maxUploadBytes: 1024 * 1024 }); });
afterEach(() => {});

const transparentPng = () => sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 220, g: 20, b: 20, alpha: 0.5 } } }).png().toBuffer();
const opaquePng = () => sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer();
const backgroundJpeg = () => sharp({ create: { width: 40, height: 30, channels: 3, background: '#287a45' } }).jpeg().toBuffer();

describe('image validation', () => {
  it('detects actual alpha values', async () => {
    expect(await hasTransparentPixels(await transparentPng())).toBe(true);
    expect(await hasTransparentPixels(await opaquePng())).toBe(false);
  });

  it('rejects opaque garment PNGs', async () => {
    const response = await request(app).post('/api/garments').attach('image', await opaquePng(), 'shirt.png');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/fully opaque/i);
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
