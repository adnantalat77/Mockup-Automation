import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { ShopifyProductDetail } from '@mockup-automation/shared';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import { PublicationError, PublishingService } from './publishing.js';

const image = { id: 'gid://shopify/ProductImage/10', url: 'https://cdn.shopify.com/black.png', associatedColors: ['Black'], association: 'reliable' as const, validation: 'transparent' as const };
const product: ShopifyProductDetail = {
  id: 'gid://shopify/Product/123', title: 'Test Shirt', handle: 'test-shirt', status: 'ACTIVE', colors: ['Black'], sizes: ['M', 'L'], images: [image],
  variants: [1, 2].map((id) => ({ id: `gid://shopify/ProductVariant/${id}`, title: `Black / ${id === 1 ? 'M' : 'L'}`, color: 'Black', size: id === 1 ? 'M' : 'L', selectedOptions: [{ name: 'Color', value: 'Black' }], associatedImageIds: [image.id] }))
};

async function waitBatch(service: BatchService, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { const batch = await service.get(id); if (batch.status !== 'running') return batch; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('Batch timeout');
}

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'publish-'));
  const assets = new AssetStore(root); await assets.init();
  const backgroundBytes = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#fff' } }).png().toBuffer();
  const garment = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
  const background = await assets.save('background', backgroundBytes, 'png', { originalName: 'background.png', width: 30, height: 30 });
  const reader = { getProduct: vi.fn().mockResolvedValue(product), downloadImage: vi.fn().mockResolvedValue(garment) };
  const batches = new BatchService(root, assets, reader as any); await batches.init();
  const batch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
  const live = { complete: true as const, mediaIds: ['gid://shopify/MediaImage/50'], variants: product.variants.map((variant) => ({ id: variant.id, color: variant.color, mediaIds: ['gid://shopify/MediaImage/50'] })) };
  const api = {
    getProduct: vi.fn().mockResolvedValue(product),
    getPublicationState: vi.fn().mockImplementation(async () => structuredClone(live)),
    stageImage: vi.fn().mockResolvedValue('https://staged.example/image'),
    createImageFile: vi.fn().mockResolvedValue({ id: 'gid://shopify/MediaImage/99', fileStatus: 'PROCESSING' }),
    waitForFileReady: vi.fn().mockResolvedValue(undefined), addFileToProduct: vi.fn().mockImplementation(async (id: string) => { if (!live.mediaIds.includes(id)) live.mediaIds.push(id); }),
    removeFileFromProduct: vi.fn().mockResolvedValue(undefined), appendVariantMedia: vi.fn().mockResolvedValue(undefined),
    detachVariantMedia: vi.fn().mockResolvedValue(undefined), reorderMedia: vi.fn().mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; }), deleteFile: vi.fn().mockResolvedValue(undefined),
    verifyFileDeletionSafe: vi.fn().mockResolvedValue({ safe: true, reason: 'operation-owned' }),
    ...overrides
  };
  api.appendVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id) && !variant.mediaIds.includes(mediaId)) variant.mediaIds.push(mediaId); });
  api.detachVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = variant.mediaIds.filter((id) => id !== mediaId); });
  api.removeFileFromProduct.mockImplementation(async (mediaId: string) => { live.mediaIds = live.mediaIds.filter((id) => id !== mediaId); });
  const publishing = new PublishingService(root, assets, batches, api as any); await publishing.init();
  return { root, assets, batches, batch, api, publishing, live };
}

describe('PublishingService', () => {
  it('validates and publishes all size variants for a color', async () => {
    const { batch, api, publishing } = await fixture();
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: true, imageCount: 1, variantCount: 2 });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('published');
    expect(api.appendVariantMedia).toHaveBeenCalledWith(product.id, 'gid://shopify/MediaImage/99', product.variants.map((variant) => variant.id));
  });

  it('prevents duplicate publication of a completed operation', async () => {
    const { batch, publishing } = await fixture();
    await publishing.publish(batch.id);
    await expect(publishing.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
  });

  it('records media processing and partial publication failures', async () => {
    const { batch, publishing } = await fixture({ waitForFileReady: vi.fn().mockRejectedValue(new Error('Media processing failed.')) });
    const operation = await publishing.publish(batch.id);
    expect(operation).toMatchObject({ status: 'partial', items: [{ status: 'failed', error: 'Media processing failed.' }] });
    expect(operation.items[0].createdMediaId).toBe('gid://shopify/MediaImage/99');
  });

  it('persists immutable atomic checkpoints for recovery', async () => {
    const { root, batch, publishing } = await fixture();
    const operation = await publishing.publish(batch.id);
    const files = (await readdir(path.join(root, 'publications', operation.id))).filter((name) => name.endsWith('.json')).sort();
    expect(files[0]).toBe('000000.json');
    expect(files.length).toBeGreaterThan(4);
    expect(new Set(files).size).toBe(files.length);
  });

  it('marks an interrupted publication for safe retry on restart', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id);
    const directory = path.join(root, 'publications', operation.id);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    const interrupted = { ...operation, status: 'publishing' as const };
    await writeFile(path.join(directory, `${String(files.length).padStart(6, '0')}.json`), JSON.stringify(interrupted), { flag: 'wx' });
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(operation.id).status).toBe('partial');
  });

  it('rolls back created media and restores original ordering', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    const rolledBack = await publishing.rollback(published.id);
    expect(rolledBack.status).toBe('rolled_back');
    expect(api.detachVariantMedia).toHaveBeenCalled(); expect(api.deleteFile).toHaveBeenCalledWith('gid://shopify/MediaImage/99');
    expect(api.reorderMedia).toHaveBeenCalledWith(product.id, ['gid://shopify/MediaImage/50']);
  });

  it('records partial rollback failures for safe retry', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    api.deleteFile.mockRejectedValueOnce(new Error('Delete failed.'));
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'rollback_partial' });
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'rolled_back' });
  });

  it('blocks rollback when external Shopify media changes are detected', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    api.getPublicationState.mockResolvedValueOnce({ complete: true, mediaIds: ['gid://shopify/MediaImage/50', 'gid://shopify/MediaImage/99', 'gid://shopify/MediaImage/777'], variants: [] });
    const result = await publishing.rollback(published.id);
    expect(result.status).toBe('conflict'); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain file creation result', async () => {
    const create = vi.fn().mockRejectedValue(new Error('connection lost after request'));
    const { batch, publishing } = await fixture({ createImageFile: create });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'conflict', items: [{ uncertainCreation: true }] });
    await expect(publishing.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(create).toHaveBeenCalledOnce();
  });

  it('reconciles live state before retrying a partial association', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.appendVariantMedia.mockRejectedValueOnce(new Error('temporary failure')).mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => {
      for (const variant of live.variants) if (variantIds.includes(variant.id) && !variant.mediaIds.includes(mediaId)) variant.mediaIds.push(mediaId);
    });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'partial' });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('safely retries failures before staging and product-reference mutation boundaries', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.stageImage.mockRejectedValueOnce(new Error('staging unavailable')).mockResolvedValue('https://staged.example/image');
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'partial' });
    api.addFileToProduct.mockRejectedValueOnce(new Error('reference unavailable')).mockImplementation(async (id: string) => { if (!live.mediaIds.includes(id)) live.mediaIds.push(id); });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'partial' });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('safely resumes after the published-order mutation boundary fails', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.reorderMedia.mockRejectedValueOnce(new Error('order job unavailable')).mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'partial' });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('rejects external variant-media changes before rollback', async () => {
    const { batch, publishing, api, live } = await fixture();
    const published = await publishing.publish(batch.id);
    live.variants[0].mediaIds.push('gid://shopify/MediaImage/777');
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'conflict' });
    expect(api.detachVariantMedia).not.toHaveBeenCalled();
  });

  it('preserves a created file when global references cannot be proven exclusive', async () => {
    const { batch, publishing, api } = await fixture();
    const published = await publishing.publish(batch.id);
    api.verifyFileDeletionSafe.mockResolvedValueOnce({ safe: false, reason: 'shared reference may exist' });
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'conflict' });
    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('recovers from the latest complete checkpoint when a newer file is incomplete', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id); const directory = path.join(root, 'publications', operation.id);
    const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json`), '{"truncated":');
    await writeFile(path.join(directory, `${String(count + 1).padStart(6, '0')}.json.tmp`), '{');
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(operation.id).status).toBe('published');
  });
});
