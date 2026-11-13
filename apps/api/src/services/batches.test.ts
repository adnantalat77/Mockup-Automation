import crypto from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { ShopifyProductDetail } from '@mockup-automation/shared';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import { ShopifyError } from './shopify.js';

const product = (colors: string[], images: ShopifyProductDetail['images']): ShopifyProductDetail => ({
  id: 'gid://shopify/Product/123', title: 'Test Shirt', handle: 'test-shirt', status: 'ACTIVE', colors, sizes: ['M'], images,
  variants: colors.map((color, index) => ({ id: `gid://shopify/ProductVariant/${index + 1}`, title: `${color} / M`, color, size: 'M', selectedOptions: [{ name: 'Color', value: color }], associatedImageIds: images.filter((image) => image.associatedColors.includes(color)).map((image) => image.id) }))
});

const image = (id: number, color: string) => ({ id: `gid://shopify/ProductImage/${id}`, mediaId: `gid://shopify/MediaImage/${id}`, url: `https://cdn.shopify.com/${id}.png`, associatedColors: [color], association: 'reliable' as const, validation: 'transparent' as const });
const waitFor = async (service: BatchService, id: string) => {
  for (let count = 0; count < 100; count += 1) {
    const batch = await service.get(id);
    if (batch.status !== 'running') return batch;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Batch did not finish.');
};

async function fixture(shopify: any, concurrency = 2, compositor?: any) {
  const root = await mkdtemp(path.join(tmpdir(), 'mockup-batch-'));
  const assets = new AssetStore(root); await assets.init();
  const background = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const saved = await assets.save('background', background, 'png', { originalName: 'background.png', width: 40, height: 30 });
  const service = new BatchService(root, assets, shopify, concurrency, compositor); await service.init();
  return { root, assets, service, background: saved };
}

describe('BatchService', () => {
  it('generates one preview for every reliably mapped color', async () => {
    const catalog = product(['Black', 'Navy'], [image(1, 'Black'), image(2, 'Navy')]);
    const garment = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const shopify = { getProduct: vi.fn().mockResolvedValue(catalog), downloadImage: vi.fn().mockResolvedValue(garment) };
    const { service, background } = await fixture(shopify);
    const finished = await waitFor(service, (await service.create(catalog.id, background.id)).id);
    expect(finished.status).toBe('completed');
    expect(finished.counts).toMatchObject({ success: 2, failed: 0, skipped: 0 });
    expect(finished.items.every((item) => item.preview?.url.startsWith('/api/assets/preview/'))).toBe(true);
    expect(finished.items[0]).toMatchObject({ sourceProvenance: { schemaVersion: 1, productId: catalog.id, color: 'Black', mediaId: 'gid://shopify/MediaImage/1', assetId: finished.items[0].sourceAsset?.id, transparency: { meaningful: true } }, sourceFreshness: { state: 'verified_current' } });
    expect(finished.items[0].sourceProvenance?.sha256).toBe(crypto.createHash('sha256').update(garment).digest('hex'));
    expect(finished.items[0].generationEvidence).toMatchObject({ sourceSha256: finished.items[0].sourceProvenance?.sha256, backgroundAssetId: background.id, previewAssetId: finished.items[0].preview?.id });
    expect((await service.zip(finished.id)).subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('reuses preserved transparent garment sources after originals leave the Shopify gallery', async () => {
    const original = product(['Black'], [image(1, 'Black')]);
    const replacementGallery = product(['Black'], [{ ...image(99, 'Black'), validation: 'opaque' as const }]);
    const garment = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const shopify = { getProduct: vi.fn().mockResolvedValue(original), downloadImage: vi.fn().mockResolvedValue(garment) };
    const { root, assets, service, background } = await fixture(shopify);
    const first = await waitFor(service, (await service.create(original.id, background.id)).id);
    expect(first.items[0].sourceAsset).toMatchObject({ kind: 'garment', hasTransparency: true });
    shopify.getProduct.mockResolvedValue(replacementGallery);
    const second = await waitFor(service, (await service.create(original.id, background.id)).id);
    expect(second).toMatchObject({ status: 'completed', items: [{ status: 'success', sourceImageId: first.items[0].sourceImageId, sourceAsset: first.items[0].sourceAsset, sourceFreshness: { state: 'historical_unverified' } }] });
    expect(shopify.downloadImage).toHaveBeenCalledOnce();
    const restarted = new BatchService(root, assets, shopify); await restarted.init();
    expect((await restarted.get(second.id)).items[0].sourceFreshness?.state).toBe('historical_unverified');
  });

  it('stores a changed current source separately without overwriting historical source bytes', async () => {
    const catalog = product(['Black'], [image(1, 'Black')]);
    const firstBytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const secondBytes = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 80, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const shopify = { getProduct: vi.fn().mockResolvedValue(catalog), downloadImage: vi.fn().mockResolvedValueOnce(firstBytes).mockResolvedValue(secondBytes) };
    const { service, assets, background } = await fixture(shopify);
    const first = await waitFor(service, (await service.create(catalog.id, background.id)).id);
    const second = await waitFor(service, (await service.create(catalog.id, background.id)).id);
    expect(second.items[0]).toMatchObject({ sourceFreshness: { state: 'verified_current', comparison: 'source_changed' } });
    expect(second.items[0].sourceAsset?.id).not.toBe(first.items[0].sourceAsset?.id);
    expect((await assets.bytes('garment', first.items[0].sourceAsset!.id)).buffer.equals(firstBytes)).toBe(true);
    expect((await assets.bytes('garment', second.items[0].sourceAsset!.id)).buffer.equals(secondBytes)).toBe(true);
  });

  it('skips incomplete catalogs and mapping conflicts for manual review', async () => {
    const catalog = product(['Black', 'Navy'], [image(1, 'Black'), image(2, 'Black')]);
    const { service } = await fixture({ getProduct: vi.fn(), downloadImage: vi.fn() });
    const items = service.mapItems(catalog);
    expect(items.find((item) => item.color === 'Black')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/Multiple/) });
    expect(items.find((item) => item.color === 'Navy')).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/No single/) });
  });

  it('records partial failures without discarding successful colors', async () => {
    const catalog = product(['Black', 'Navy'], [image(1, 'Black'), image(2, 'Navy')]);
    const garment = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
    const shopify = { getProduct: vi.fn().mockResolvedValue(catalog), downloadImage: vi.fn().mockImplementation((url: string) => url.includes('/1.') ? Promise.reject(new ShopifyError('Permanent source failure.', 400)) : Promise.resolve(garment)) };
    const { service, background } = await fixture(shopify);
    const finished = await waitFor(service, (await service.create(catalog.id, background.id)).id);
    expect(finished.status).toBe('partial');
    expect(finished.counts).toMatchObject({ success: 1, failed: 1 });
  });

  it('retries one transient source failure', async () => {
    const catalog = product(['Black'], [image(1, 'Black')]);
    const garment = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
    const shopify = { getProduct: vi.fn().mockResolvedValue(catalog), downloadImage: vi.fn().mockRejectedValueOnce(new ShopifyError('Temporary failure.', 502)).mockResolvedValue(garment) };
    const { service, background } = await fixture(shopify);
    const finished = await waitFor(service, (await service.create(catalog.id, background.id)).id);
    expect(finished.items[0]).toMatchObject({ status: 'success', attempts: 2 });
  });

  it('cancels queued work while allowing an in-flight composite to finish safely', async () => {
    const catalog = product(['Black', 'Navy'], [image(1, 'Black'), image(2, 'Navy')]);
    const garment = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).png().toBuffer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const output = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
    const compositor = vi.fn().mockImplementation(async () => { await gate; return output; });
    const shopify = { getProduct: vi.fn().mockResolvedValue(catalog), downloadImage: vi.fn().mockResolvedValue(garment) };
    const { service, background } = await fixture(shopify, 1, compositor);
    const started = await service.create(catalog.id, background.id);
    while ((await service.get(started.id)).counts.processing === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await service.cancel(started.id); release();
    const finished = await waitFor(service, started.id);
    expect(finished.status).toBe('cancelled');
    expect(finished.counts).toMatchObject({ success: 1, cancelled: 1 });
  });
});
