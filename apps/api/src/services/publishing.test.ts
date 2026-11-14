import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { ShopifyProductDetail } from '@mockup-automation/shared';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import { PublicationError, PublishingService } from './publishing.js';
import { atomicWriteFile, PersistenceError } from './persistence.js';

const image = { id: 'gid://shopify/ProductImage/10', mediaId: 'gid://shopify/MediaImage/50', url: 'https://cdn.shopify.com/black.png', associatedColors: ['Black'], association: 'reliable' as const, validation: 'transparent' as const };
const product: ShopifyProductDetail = {
  id: 'gid://shopify/Product/15608846975264', title: 'Mockup Automation - TEST ONLY', handle: 'test-shirt', status: 'DRAFT', colors: ['Black'], sizes: ['M', 'L'], images: [image],
  variants: [1, 2].map((id) => ({ id: `gid://shopify/ProductVariant/${id}`, title: `Black / ${id === 1 ? 'M' : 'L'}`, color: 'Black', size: id === 1 ? 'M' : 'L', selectedOptions: [{ name: 'Color', value: 'Black' }], associatedImageIds: [image.id] }))
};
const productionProduct: ShopifyProductDetail = { ...product, id: 'gid://shopify/Product/999', title: 'Allowlisted Production Shirt', handle: 'allowlisted-production-shirt', status: 'ACTIVE' };

const releaseOneColors = ['Black', 'Navy', 'White'];
const releaseOneProduct: ShopifyProductDetail = {
  id: 'gid://shopify/Product/888', title: 'Release 1 Draft Shirt', handle: 'release-1-draft-shirt', status: 'DRAFT', colors: releaseOneColors, sizes: ['S', 'M', 'L'],
  images: releaseOneColors.map((color, index) => ({ id: `gid://shopify/ProductImage/${700 + index}`, mediaId: `gid://shopify/MediaImage/${700 + index}`, url: `https://cdn.shopify.com/${color.toLowerCase()}-source.png`, associatedColors: [color], association: 'reliable', validation: 'transparent' })),
  variants: releaseOneColors.flatMap((color, colorIndex) => ['S', 'M', 'L'].map((size, sizeIndex) => ({
    id: `gid://shopify/ProductVariant/${7000 + colorIndex * 3 + sizeIndex}`, title: `${color} / ${size}`, color, size,
    selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: size }], associatedImageIds: [`gid://shopify/ProductImage/${700 + colorIndex}`]
  })))
};

const acceptanceGalleryColors = ['Solid White Blend', 'Soft Cream', 'Yellow', 'Heather Dust', 'Heather Prism Ice Blue', 'Heather Mint', 'Silver', 'Ash', 'Natural', 'Vintage White', 'Heather Ice Blue'];
const acceptanceBatchColors = [...acceptanceGalleryColors.slice(1), acceptanceGalleryColors[0]];
const acceptanceImages = acceptanceGalleryColors.map((color, index) => ({
  id: `gid://shopify/ProductImage/${800 + index}`, mediaId: `gid://shopify/MediaImage/${800 + index}`,
  url: `https://cdn.shopify.com/acceptance-${index}.png`, associatedColors: [color], association: 'reliable' as const, validation: 'transparent' as const
}));
const acceptanceProduct: ShopifyProductDetail = {
  id: 'gid://shopify/Product/777', title: 'Release 1 Acceptance Draft', handle: 'release-1-acceptance-draft', status: 'DRAFT',
  colors: acceptanceBatchColors, sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'], images: acceptanceImages,
  variants: acceptanceBatchColors.flatMap((color, colorIndex) => {
    const sizes = color === 'Vintage White' ? ['S', 'M', 'L', 'XL', '2XL'] : ['S', 'M', 'L', 'XL', '2XL', '3XL'];
    const image = acceptanceImages.find((candidate) => candidate.associatedColors[0] === color)!;
    return sizes.map((size, sizeIndex) => ({
      id: `gid://shopify/ProductVariant/${8000 + colorIndex * 6 + sizeIndex}`, title: `${color} / ${size}`, color, size,
      selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: size }], associatedImageIds: [image.id]
    }));
  })
};

const largeColors = ['Black', 'Navy', 'White', 'Red', 'Green', 'Blue', 'Gray', 'Gold'];
const largeProduct: ShopifyProductDetail = {
  id: 'gid://shopify/Product/999', title: 'Allowlisted Production Shirt', handle: 'allowlisted-shirt', status: 'ACTIVE', colors: largeColors,
  sizes: Array.from({ length: 10 }, (_value, index) => `Size ${index + 1}`),
  images: largeColors.map((color, index) => ({ id: `gid://shopify/MediaImage/${50 + index}`, mediaId: `gid://shopify/MediaImage/${50 + index}`, url: `https://cdn.shopify.com/${color.toLowerCase()}.png`, associatedColors: [color], association: 'reliable', validation: 'transparent' })),
  variants: largeColors.flatMap((color, colorIndex) => Array.from({ length: 10 }, (_value, sizeIndex) => ({
    id: `gid://shopify/ProductVariant/${1000 + colorIndex * 10 + sizeIndex}`, title: `${color} / Size ${sizeIndex + 1}`, color, size: `Size ${sizeIndex + 1}`,
    selectedOptions: [{ name: 'Color', value: color }, { name: 'Size', value: `Size ${sizeIndex + 1}` }], associatedImageIds: [`gid://shopify/MediaImage/${50 + colorIndex}`]
  })))
};

async function waitBatch(service: BatchService, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) { const batch = await service.get(id); if (batch.status !== 'running') return batch; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('Batch timeout');
}

async function fixture(overrides: Record<string, unknown> = {}, selectedProduct: ShopifyProductDetail = product, allowedProductIds: string[] = [], sourceDownloader?: (url: string) => Promise<Buffer>, selectedBackgroundBytes?: Buffer) {
  const root = await mkdtemp(path.join(tmpdir(), 'publish-'));
  const assets = new AssetStore(root); await assets.init();
  const backgroundBytes = selectedBackgroundBytes ?? await sharp({ create: { width: 30, height: 30, channels: 3, background: '#fff' } }).png().toBuffer();
  const garment = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
  const background = await assets.save('background', backgroundBytes, 'png', { originalName: 'background.png', width: 30, height: 30 });
  const downloadSource = sourceDownloader ?? (async () => garment);
  const reader = { getProduct: vi.fn().mockResolvedValue(selectedProduct), downloadImage: vi.fn().mockImplementation(downloadSource) };
  const batches = new BatchService(root, assets, reader as any); await batches.init();
  const batch = await waitBatch(batches, (await batches.create(selectedProduct.id, background.id)).id);
  const originalMediaIds = selectedProduct.images.map((entry, index) => entry.mediaId ?? (entry.id.startsWith('gid://shopify/MediaImage/') ? entry.id : `gid://shopify/MediaImage/${50 + index}`));
  const mediaByImageId = new Map(selectedProduct.images.map((entry, index) => [entry.id, originalMediaIds[index]]));
  const live = { complete: true as const, mediaIds: [...originalMediaIds], variants: selectedProduct.variants.map((variant) => ({ id: variant.id, color: variant.color, mediaIds: [mediaByImageId.get(variant.associatedImageIds[0]) ?? originalMediaIds[0]] })) };
  let createdIndex = 0;
  const generatedStart = selectedProduct === product ? 99 : 100;
  const api = {
    getProduct: vi.fn().mockResolvedValue(selectedProduct),
    getPublicationState: vi.fn().mockImplementation(async () => structuredClone(live)),
    downloadImage: vi.fn().mockImplementation(downloadSource),
    stageImage: vi.fn().mockResolvedValue('https://staged.example/image'),
    createImageFile: vi.fn().mockImplementation(async () => ({ id: `gid://shopify/MediaImage/${generatedStart + createdIndex++}`, fileStatus: 'PROCESSING' })),
    waitForFileReady: vi.fn().mockResolvedValue(undefined), addFileToProduct: vi.fn().mockImplementation(async (id: string) => { if (!live.mediaIds.includes(id)) live.mediaIds.push(id); }),
    removeFileFromProduct: vi.fn().mockResolvedValue(undefined), appendVariantMedia: vi.fn().mockResolvedValue(undefined),
    replaceVariantMedia: vi.fn().mockResolvedValue(undefined),
    detachVariantMedia: vi.fn().mockResolvedValue(undefined), reorderMedia: vi.fn().mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; }), deleteFile: vi.fn().mockResolvedValue(undefined),
    verifyFileDeletionSafe: vi.fn().mockResolvedValue({ safe: true, reason: 'operation-owned' }),
    ...overrides
  };
  api.appendVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id) && !variant.mediaIds.includes(mediaId)) variant.mediaIds.push(mediaId); });
  api.replaceVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = [mediaId]; });
  api.detachVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = variant.mediaIds.filter((id) => id !== mediaId); });
  api.removeFileFromProduct.mockImplementation(async (mediaId: string) => { live.mediaIds = live.mediaIds.filter((id) => id !== mediaId); });
  const publishing = new PublishingService(root, assets, batches, api as any, allowedProductIds); await publishing.init();
  return { root, assets, batches, batch, background, api, publishing, live };
}

async function restoredPartialFixture() {
  const result = await fixture();
  result.api.replaceVariantMedia.mockRejectedValueOnce(new Error('association failed'));
  const operation = await result.publishing.publish(result.batch.id);
  result.live.mediaIds = ['gid://shopify/MediaImage/50'];
  for (const variant of result.live.variants) variant.mediaIds = ['gid://shopify/MediaImage/50'];
  vi.clearAllMocks();
  return { ...result, operation };
}

async function retainedRollbackFixture(selectedProduct: ShopifyProductDetail = product, allowedProductIds: string[] = []) {
  const result = await fixture({}, selectedProduct, allowedProductIds);
  const confirmation = selectedProduct.id === product.id ? 'PUBLISH' : `PUBLISH ${selectedProduct.id}`;
  const published = await result.publishing.publish(result.batch.id, confirmation);
  result.api.verifyFileDeletionSafe.mockResolvedValueOnce({ safe: false, reason: 'global references cannot be proven exclusive', reasonCode: 'global_references_unverifiable' });
  const operation = await result.publishing.rollback(published.id, 'no_global_delete');
  expect(operation).toMatchObject({ status: 'conflict', productRestored: true, items: [{ status: 'rolled_back', cleanupPending: true }] });
  vi.clearAllMocks();
  result.api.getProduct.mockResolvedValue(selectedProduct);
  result.api.getPublicationState.mockImplementation(async () => structuredClone(result.live));
  return { ...result, operation };
}

describe('PublishingService', () => {
  it.each([
    ['write', 'ENOSPC', { beforeWrite: () => { throw Object.assign(new Error('injected write failure'), { code: 'ENOSPC' }); } }],
    ['flush', 'EIO', { beforeFlush: () => { throw Object.assign(new Error('injected flush failure'), { code: 'EIO' }); } }],
    ['rename', 'EACCES', { beforeRename: () => { throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' }); } }]
  ])('blocks mutation and later transitions when intent checkpoint %s fails', async (_boundary, code, hooks) => {
    const base = await fixture(); let writes = 0;
    const writer = vi.fn(async (destination: string, data: string | Buffer) => { writes += 1; if (writes === 3) await atomicWriteFile(destination, data, hooks); else await atomicWriteFile(destination, data); });
    const publishing = new PublishingService(base.root, base.assets, base.batches, base.api as any, [], writer);
    await publishing.init(); vi.clearAllMocks();
    await expect(publishing.publish(base.batch.id)).rejects.toThrow(/persistence failed/);
    expect(code).toBeTruthy();
    expect(base.api.stageImage).not.toHaveBeenCalled(); expect(base.api.createImageFile).not.toHaveBeenCalled();
    await expect(publishing.publish(base.batch.id)).rejects.toMatchObject({ status: 503 });
  });

  it('does not blindly continue or retry after mutation succeeds but result persistence fails', async () => {
    const base = await fixture(); let writes = 0;
    const writer = vi.fn(async (destination: string, data: string | Buffer) => { writes += 1; if (writes === 6) throw new PersistenceError('injected result persistence failure', 'ENOSPC'); await atomicWriteFile(destination, data); });
    const publishing = new PublishingService(base.root, base.assets, base.batches, base.api as any, [], writer);
    await publishing.init(); vi.clearAllMocks();
    await expect(publishing.publish(base.batch.id)).rejects.toThrow(/persistence failed/);
    expect(base.api.createImageFile).toHaveBeenCalledOnce(); expect(base.api.addFileToProduct).not.toHaveBeenCalled();
    const operation = publishing.list()[0];
    await expect(publishing.resume(operation.id, operation.batchId)).rejects.toMatchObject({ status: 503 });
    expect(base.api.createImageFile).toHaveBeenCalledOnce();
  });

  it('blocks every publication state transition while restored-data reconciliation is pending', async () => {
    const base = await fixture(); const operation = await base.publishing.publish(base.batch.id);
    await writeFile(path.join(base.root, 'RESTORED_FROM_BACKUP.json'), JSON.stringify({ requiresShopifyReconciliation: true }));
    vi.clearAllMocks();
    await expect(base.publishing.publish(base.batch.id)).rejects.toMatchObject({ status: 503 });
    await expect(base.publishing.resume(operation.id, operation.batchId)).rejects.toMatchObject({ status: 503 });
    await expect(base.publishing.rollback(operation.id, 'no_global_delete')).rejects.toMatchObject({ status: 503 });
    await expect(base.publishing.abandon(operation.id, 'Restoration reconciliation is still pending')).rejects.toMatchObject({ status: 503 });
    await expect(base.publishing.finalizeRollback(operation.id, `FINALIZE ${operation.id} FILES RETAINED`)).rejects.toMatchObject({ status: 503 });
    expect(base.api.getPublicationState).not.toHaveBeenCalled(); expect(base.api.createImageFile).not.toHaveBeenCalled(); expect(base.api.removeFileFromProduct).not.toHaveBeenCalled();
  });

  it('reconciles an exact published restoration and clears the marker with durable evidence and zero mutations', async () => {
    const base = await fixture(); const operation = await base.publishing.publish(base.batch.id);
    const marker = path.join(base.root, 'RESTORED_FROM_BACKUP.json');
    await writeFile(marker, JSON.stringify({ requiresShopifyReconciliation: true, restoredAt: '2026-11-13T00:00:00.000Z' }));
    vi.clearAllMocks();
    const readiness = await base.publishing.validateRestoration();
    expect(readiness).toMatchObject({ pending: true, eligible: true, products: [{ productId: product.id, controllingOperationId: operation.id, outcome: 'exactly_published' }] });
    const cleared = await base.publishing.clearRestoration(readiness.confirmationText!);
    expect(cleared).toMatchObject({ pending: false, eligible: true, alreadyCleared: false });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path.join(base.root, cleared.evidencePath!), 'utf8'))).toMatchObject({ schemaVersion: 1, kind: 'restoration_reconciliation', eligible: true });
    expect(base.api.stageImage).not.toHaveBeenCalled(); expect(base.api.createImageFile).not.toHaveBeenCalled(); expect(base.api.addFileToProduct).not.toHaveBeenCalled();
    expect(base.api.replaceVariantMedia).not.toHaveBeenCalled(); expect(base.api.removeFileFromProduct).not.toHaveBeenCalled(); expect(base.api.reorderMedia).not.toHaveBeenCalled();
    await expect(base.publishing.clearRestoration(readiness.confirmationText!)).resolves.toMatchObject({ pending: false, alreadyCleared: true });
  });

  it('reconciles exact rolled-back retained-file state without treating globally retained files as product references', async () => {
    const base = await retainedRollbackFixture();
    const expected = `FINALIZE ${base.operation.id} FILES RETAINED`;
    const finalized = await base.publishing.finalizeRollback(base.operation.id, expected);
    await writeFile(path.join(base.root, 'RESTORED_FROM_BACKUP.json'), JSON.stringify({ requiresShopifyReconciliation: true }));
    vi.clearAllMocks();
    await expect(base.publishing.validateRestoration()).resolves.toMatchObject({ eligible: true, products: [{ controllingOperationId: finalized.id, outcome: 'rolled_back_files_retained' }] });
    expect(base.api.createImageFile).not.toHaveBeenCalled(); expect(base.api.removeFileFromProduct).not.toHaveBeenCalled();
  });

  it.each([
    ['unexpected gallery media', (live: any) => live.mediaIds.push('gid://shopify/MediaImage/777'), /ordering/],
    ['variant missing', (live: any) => live.variants.pop(), /variant set|missing/],
    ['variant added', (live: any) => live.variants.push({ id: 'gid://shopify/ProductVariant/777', color: 'Black', mediaIds: [] }), /variant set|unexpected/],
    ['variant association changed', (live: any) => { live.variants[0].mediaIds = ['gid://shopify/MediaImage/777']; }, /media changed/]
  ])('keeps the restoration marker active when %s', async (_name, mutate, diagnostic) => {
    const base = await fixture(); await base.publishing.publish(base.batch.id);
    const marker = path.join(base.root, 'RESTORED_FROM_BACKUP.json'); await writeFile(marker, JSON.stringify({ requiresShopifyReconciliation: true }));
    mutate(base.live); vi.clearAllMocks();
    const readiness = await base.publishing.validateRestoration();
    expect(readiness.eligible).toBe(false); expect(readiness.errors.join(' ')).toMatch(diagnostic);
    await expect(base.publishing.clearRestoration(readiness.confirmationText!)).rejects.toMatchObject({ status: 409 });
    await expect(access(marker)).resolves.toBeUndefined();
    expect(base.api.createImageFile).not.toHaveBeenCalled(); expect(base.api.replaceVariantMedia).not.toHaveBeenCalled();
  });

  it('fails closed for incomplete snapshots, Shopify read failures, unresolved intents, and uncertain file ownership', async () => {
    const base = await fixture(); const operation = await base.publishing.publish(base.batch.id);
    await writeFile(path.join(base.root, 'RESTORED_FROM_BACKUP.json'), JSON.stringify({ requiresShopifyReconciliation: true }));
    base.api.getPublicationState.mockResolvedValueOnce({ ...structuredClone(base.live), complete: false });
    expect((await base.publishing.validateRestoration()).errors.join(' ')).toMatch(/incomplete/);
    base.api.getPublicationState.mockRejectedValueOnce(new Error('read unavailable'));
    expect((await base.publishing.validateRestoration()).errors.join(' ')).toMatch(/read unavailable/);
    const item = base.publishing.get(operation.id).items[0]; item.intent = 'create_file'; item.uncertainCreation = true;
    expect((await base.publishing.validateRestoration()).errors.join(' ')).toMatch(/unresolved or uncertain/);
  });

  it('persists reconciliation evidence first and refuses stale clearance without repeating any mutation', async () => {
    const base = await fixture(); await base.publishing.publish(base.batch.id);
    const marker = path.join(base.root, 'RESTORED_FROM_BACKUP.json'); await writeFile(marker, JSON.stringify({ requiresShopifyReconciliation: true }));
    const status = await base.publishing.restorationStatus(); let reads = 0;
    base.api.getPublicationState.mockImplementation(async () => { reads += 1; const state = structuredClone(base.live); if (reads >= 2) state.mediaIds.push('gid://shopify/MediaImage/777'); return state; });
    vi.clearAllMocks();
    await expect(base.publishing.clearRestoration(status.confirmationText!)).rejects.toMatchObject({ status: 409 });
    await expect(access(marker)).resolves.toBeUndefined();
    expect((await readdir(path.join(base.root, 'restoration-reconciliations'))).length).toBe(1);
    expect(base.api.createImageFile).not.toHaveBeenCalled(); expect(base.api.reorderMedia).not.toHaveBeenCalled();
  });

  it('keeps the marker active when reconciliation evidence cannot be persisted', async () => {
    const base = await fixture(); await base.publishing.publish(base.batch.id);
    const marker = path.join(base.root, 'RESTORED_FROM_BACKUP.json'); await writeFile(marker, JSON.stringify({ requiresShopifyReconciliation: true }));
    const writer = vi.fn(async (destination: string, data: string | Buffer) => {
      if (destination.includes('restoration-reconciliations')) throw new PersistenceError('injected evidence failure', 'ENOSPC');
      await atomicWriteFile(destination, data);
    });
    const recovered = new PublishingService(base.root, base.assets, base.batches, base.api as any, [], writer); await recovered.init();
    const status = await recovered.restorationStatus(); vi.clearAllMocks();
    await expect(recovered.clearRestoration(status.confirmationText!)).rejects.toThrow(/marker remains active/);
    await expect(access(marker)).resolves.toBeUndefined();
    expect(base.api.createImageFile).not.toHaveBeenCalled(); expect(base.api.replaceVariantMedia).not.toHaveBeenCalled();
  });

  it('allows an empty restored data set to be explicitly reconciled without Shopify access', async () => {
    const base = await fixture();
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'empty-restore-')); const assets = new AssetStore(emptyRoot); await assets.init();
    const batches = new BatchService(emptyRoot, assets, { getProduct: base.api.getProduct, downloadImage: base.api.downloadImage } as any); await batches.init();
    const publishing = new PublishingService(emptyRoot, assets, batches, base.api as any); await publishing.init();
    await writeFile(path.join(emptyRoot, 'RESTORED_FROM_BACKUP.json'), JSON.stringify({ requiresShopifyReconciliation: true })); vi.clearAllMocks();
    const readiness = await publishing.validateRestoration();
    expect(readiness).toMatchObject({ pending: true, eligible: true, products: [] }); expect(base.api.getPublicationState).not.toHaveBeenCalled();
    await expect(publishing.clearRestoration(readiness.confirmationText!)).resolves.toMatchObject({ pending: false, eligible: true });
  });
  it('requires the explicit no_global_delete rollback mode before reading Shopify', async () => {
    const { batch, publishing, api } = await fixture();
    const published = await publishing.publish(batch.id);
    vi.clearAllMocks();
    await expect((publishing.rollback as any)(published.id)).rejects.toMatchObject({ status: 400 });
    await expect((publishing.rollback as any)(published.id, 'delete_files')).rejects.toMatchObject({ status: 400 });
    expect(api.getPublicationState).not.toHaveBeenCalled();
    expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled();
    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('validates and publishes all size variants for a color', async () => {
    const { batch, api, publishing } = await fixture();
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: true, imageCount: 1, variantCount: 2 });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('published');
    expect(api.replaceVariantMedia).toHaveBeenCalledWith(product.id, 'gid://shopify/MediaImage/99', product.variants.map((variant) => variant.id));
    expect(api.appendVariantMedia).not.toHaveBeenCalled();
  });

  it('completes the Release 1 three-color nine-variant workflow and blocks a second independent publication', async () => {
    const rgbByColor: Record<string, { r: number; g: number; b: number }> = { black: { r: 15, g: 16, b: 17 }, navy: { r: 20, g: 35, b: 90 }, white: { r: 235, g: 235, b: 235 } };
    const sources = new Map<string, Buffer>();
    for (const color of releaseOneColors) {
      const foreground = await sharp({ create: { width: 10, height: 10, channels: 4, background: { ...rgbByColor[color.toLowerCase()], alpha: 1 } } }).png().toBuffer();
      sources.set(color.toLowerCase(), await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: foreground, gravity: 'center' }]).png().toBuffer());
    }
    const background = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 30, g: 150, b: 70 } } }).png().toBuffer();
    const downloader = async (url: string) => {
      const color = releaseOneColors.find((candidate) => url.includes(candidate.toLowerCase()));
      if (!color) throw new Error('unexpected source URL');
      return Buffer.from(sources.get(color.toLowerCase())!);
    };
    const base = await fixture({}, releaseOneProduct, [releaseOneProduct.id], downloader, background);
    expect(base.batch).toMatchObject({ status: 'completed', counts: { total: 3, success: 3 } });
    for (const item of base.batch.items) {
      expect(item).toMatchObject({ status: 'success', sourceFreshness: { state: 'verified_current' }, sourceProvenance: { productId: releaseOneProduct.id, color: item.color }, generationEvidence: { backgroundAssetId: base.background.id } });
      const preserved = (await base.assets.bytes('garment', item.sourceAsset!.id)).buffer;
      const expectedSource = sources.get(item.color.toLowerCase())!;
      expect(preserved.equals(expectedSource)).toBe(true);
      expect(item.sourceProvenance!.sha256).toBe(crypto.createHash('sha256').update(expectedSource).digest('hex'));
      const preview = (await base.assets.bytes('preview', item.preview!.id)).buffer;
      expect(item.generationEvidence!.previewSha256).toBe(crypto.createHash('sha256').update(preview).digest('hex'));
      const corner = await sharp(preview).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      const center = await sharp(preview).extract({ left: 15, top: 15, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      expect([...corner]).toEqual([30, 150, 70]);
      const expectedForeground = rgbByColor[item.color.toLowerCase()];
      expect([...center]).toEqual([expectedForeground.r, expectedForeground.g, expectedForeground.b]);
    }
    const readiness = await base.publishing.validate(base.batch.id);
    expect(readiness).toMatchObject({ ready: true, imageCount: 3, variantCount: 9, expectedFinalGalleryImageCount: 3 });
    const operation = await base.publishing.publish(base.batch.id, `PUBLISH ${releaseOneProduct.id}`);
    expect(operation).toMatchObject({ status: 'published', publicationMode: 'replace_gallery' });
    expect(operation.items).toHaveLength(3); expect(operation.completedSteps).toContain('published-order');
    expect(base.live.mediaIds).toEqual(operation.expectedPublishedMediaOrder);
    for (const item of operation.items) for (const variantId of item.variantIds) expect(base.live.variants.find((variant) => variant.id === variantId)?.mediaIds).toEqual([item.createdMediaId]);
    const checkpointFiles = (await readdir(path.join(base.root, 'publications', operation.id))).filter((name) => /^\d{6}\.json$/.test(name));
    const terminal = JSON.parse(await readFile(path.join(base.root, 'publications', operation.id, checkpointFiles.sort().at(-1)!), 'utf8'));
    expect(terminal).toMatchObject({ id: operation.id, status: 'published', expectedPublishedMediaOrder: operation.expectedPublishedMediaOrder });
    const secondBatch = await waitBatch(base.batches, (await base.batches.create(releaseOneProduct.id, base.background.id)).id);
    const secondReadiness = await base.publishing.validate(secondBatch.id);
    expect(secondReadiness.ready).toBe(false); expect(secondReadiness.errors.join(' ')).toMatch(/already processed.*repeat background replacement is not supported/i);
    await expect(base.publishing.publish(secondBatch.id, `PUBLISH ${releaseOneProduct.id}`)).rejects.toMatchObject({ status: 409 });
    expect(base.api.createImageFile).toHaveBeenCalledTimes(3);
  });

  it('plans and publishes eleven images in verified original gallery order while retaining all 65 variant mappings', async () => {
    const base = await fixture({}, acceptanceProduct, [acceptanceProduct.id]);
    expect(base.batch.items.map((item) => item.color)).toEqual(acceptanceBatchColors);
    const readiness = await base.publishing.validate(base.batch.id);
    expect(readiness).toMatchObject({ ready: true, imageCount: 11, variantCount: 65 });
    expect(readiness.colors.map((item) => item.color)).toEqual(acceptanceGalleryColors);
    const operation = await base.publishing.publish(base.batch.id, `PUBLISH ${acceptanceProduct.id}`);
    expect(operation.items.map((item) => item.color)).toEqual(acceptanceGalleryColors);
    expect(operation.originalMediaOrder).toEqual(acceptanceImages.map((image) => image.mediaId));
    expect(operation.expectedPublishedMediaOrder).toHaveLength(11);
    expect(new Set(operation.items.flatMap((item) => item.variantIds)).size).toBe(65);
    for (const item of operation.items) {
      const expectedVariants = acceptanceProduct.variants.filter((variant) => variant.color === item.color).map((variant) => variant.id);
      expect(item.variantIds).toEqual(expectedVariants);
      for (const variantId of item.variantIds) expect(base.live.variants.find((variant) => variant.id === variantId)?.mediaIds).toEqual([item.createdMediaId]);
    }
    expect(base.live.mediaIds).toEqual(operation.expectedPublishedMediaOrder);
  });

  it('derives the same canonical plan after randomized batch-item ordering', async () => {
    const base = await fixture({}, acceptanceProduct, [acceptanceProduct.id]);
    base.batch.items = [base.batch.items[4], base.batch.items[0], base.batch.items[9], base.batch.items[2], base.batch.items[7], base.batch.items[10], base.batch.items[1], base.batch.items[6], base.batch.items[3], base.batch.items[8], base.batch.items[5]];
    expect(base.batch.items.map((item) => item.color)).not.toEqual(acceptanceGalleryColors);
    const readiness = await base.publishing.validate(base.batch.id);
    expect(readiness.ready).toBe(true);
    expect(readiness.colors.map((item) => item.color)).toEqual(acceptanceGalleryColors);
  });

  it.each([
    ['duplicate', 'gid://shopify/MediaImage/700', /more than one generated color|one-to-one/i],
    ['unknown', 'gid://shopify/MediaImage/999', /not present in the verified original Shopify gallery|one-to-one/i]
  ])('fails closed for %s source-media provenance identities', async (kind, mediaId, diagnostic) => {
    const base = await fixture({}, releaseOneProduct, [releaseOneProduct.id]);
    const item = base.batch.items[1];
    item.sourceProvenance!.mediaId = mediaId;
    item.sourceAsset!.provenance!.mediaId = mediaId;
    const current = structuredClone(releaseOneProduct);
    current.images[1].mediaId = mediaId;
    base.api.getProduct.mockResolvedValue(current);
    const readiness = await base.publishing.validate(base.batch.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.errors.join(' ')).toMatch(diagnostic);
    expect(base.api.stageImage).not.toHaveBeenCalled();
  });

  it('revalidates a matching current source hash during final publication preflight', async () => {
    const { batch, publishing, api } = await fixture();
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: true });
    expect(api.downloadImage).toHaveBeenCalled();
    expect(batch.items[0]).toMatchObject({ sourceProvenance: { schemaVersion: 1 }, sourceFreshness: { state: 'verified_current' } });
  });

  it.each([
    ['detached current source', (current: ShopifyProductDetail) => { current.images = []; }, /exactly one reliable current source|historical/i],
    ['ambiguous current sources', (current: ShopifyProductDetail) => { current.images.push({ ...current.images[0], id: 'gid://shopify/ProductImage/11', mediaId: 'gid://shopify/MediaImage/51' }); }, /exactly one reliable current source/i],
    ['changed variant mapping', (current: ShopifyProductDetail) => { current.variants[0].associatedImageIds = []; }, /mapping conflicts/i]
  ])('blocks publication for %s before mutation', async (_name, mutate, message) => {
    const { batch, publishing, api } = await fixture();
    const current = structuredClone(product); mutate(current); api.getProduct.mockResolvedValue(current);
    const readiness = await publishing.validate(batch.id);
    expect(readiness.ready).toBe(false); expect(readiness.errors.join(' ')).toMatch(message);
    await expect(publishing.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.stageImage).not.toHaveBeenCalled(); expect(api.createImageFile).not.toHaveBeenCalled();
  });

  it('blocks an unchanged cached garment when provenance is missing', async () => {
    const { batch, publishing, api } = await fixture();
    delete batch.items[0].sourceProvenance;
    const readiness = await publishing.validate(batch.id);
    expect(readiness.ready).toBe(false); expect(readiness.errors.join(' ')).toMatch(/provenance is missing/i);
    expect(api.stageImage).not.toHaveBeenCalled();
  });

  it.each([
    ['source', 'uploads/garments', /source bytes/i],
    ['background', 'uploads/backgrounds', /hash evidence/i],
    ['preview', 'generated/previews', /hash evidence/i]
  ])('blocks publication when the recorded %s asset bytes change', async (kind, folder, message) => {
    const { root, batch, publishing, api } = await fixture();
    const item = batch.items[0]; const assetId = kind === 'source' ? item.sourceAsset!.id : kind === 'background' ? batch.backgroundId : item.preview!.id;
    const replacement = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 200, g: 10, b: 10, alpha: kind === 'source' ? 0.5 : 1 } } }).png().toBuffer();
    await writeFile(path.join(root, folder, `${assetId}.png`), replacement);
    const readiness = await publishing.validate(batch.id);
    expect(readiness.ready).toBe(false); expect(readiness.errors.join(' ')).toMatch(message);
    expect(api.stageImage).not.toHaveBeenCalled();
  });

  it('blocks changed, opaque, or unavailable current Shopify source bytes', async () => {
    const changed = await fixture();
    changed.api.downloadImage.mockResolvedValue(await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 99, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer());
    expect((await changed.publishing.validate(changed.batch.id)).errors.join(' ')).toMatch(/artwork changed/i);
    expect(changed.api.stageImage).not.toHaveBeenCalled();

    const opaque = await fixture();
    opaque.api.downloadImage.mockResolvedValue(await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).png().toBuffer());
    expect((await opaque.publishing.validate(opaque.batch.id)).errors.join(' ')).toMatch(/unavailable or invalid/i);

    const unavailable = await fixture(); unavailable.api.downloadImage.mockRejectedValue(new Error('download unavailable'));
    expect((await unavailable.publishing.validate(unavailable.batch.id)).errors.join(' ')).toMatch(/download unavailable/i);
  });

  it('blocks partial-operation recovery when current artwork changes after publication starts', async () => {
    const { batch, publishing, api } = await fixture();
    api.waitForFileReady.mockRejectedValueOnce(new Error('processing interrupted'));
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    api.downloadImage.mockResolvedValue(await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 90, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer());
    await expect(publishing.validateRecovery(operation.id, batch.id)).resolves.toMatchObject({ eligible: false, errors: expect.arrayContaining([expect.stringMatching(/source validation|artwork changed/i)]) });
    await expect(publishing.resume(operation.id, batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.addFileToProduct).not.toHaveBeenCalled();
  });

  it('blocks partial-operation recovery when batch regeneration replaces immutable evidence', async () => {
    const { batch, batches, publishing, api } = await fixture();
    api.stageImage.mockRejectedValueOnce(new Error('staging interrupted'));
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    await waitBatch(batches, (await batches.regenerate(batch.id, 'Black')).id);
    const readiness = await publishing.validateRecovery(operation.id, batch.id);
    expect(readiness.eligible).toBe(false); expect(readiness.errors.join(' ')).toMatch(/preview no longer matches|evidence changed/i);
    await expect(publishing.resume(operation.id, batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.createImageFile).not.toHaveBeenCalled();
  });

  it('stops before upload when preview bytes change after final preflight', async () => {
    const { root, assets, batch, publishing, api } = await fixture();
    const item = batch.items[0]; const sourceBytes = (await assets.bytes('garment', item.sourceAsset!.id)).buffer;
    const changedPreview = await sharp({ create: { width: 30, height: 30, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 1 } } }).png().toBuffer();
    api.downloadImage.mockImplementationOnce(async () => {
      await writeFile(path.join(root, 'generated', 'previews', `${item.preview!.id}.png`), changedPreview);
      return sourceBytes;
    });
    const operation = await publishing.publish(batch.id);
    expect(operation).toMatchObject({ status: 'conflict', errors: [expect.stringMatching(/preview bytes changed/i)] });
    expect(api.stageImage).not.toHaveBeenCalled(); expect(api.createImageFile).not.toHaveBeenCalled();
  });

  it('blocks sequential publication and preserves rollback of the single completed Release 1 operation', async () => {
    const { root, batch, background, batches, api, publishing, live } = await fixture();
    const first = await publishing.publish(batch.id);
    const firstCheckpointCount = (await readdir(path.join(root, 'publications', first.id))).filter((name) => name.endsWith('.json')).length;
    const secondBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    await expect(publishing.validate(secondBatch.id)).resolves.toMatchObject({ ready: false, errors: expect.arrayContaining([expect.stringMatching(/already processed/)]) });
    await expect(publishing.publish(secondBatch.id)).rejects.toMatchObject({ status: 409 });
    expect(live.mediaIds).toEqual(['gid://shopify/MediaImage/99']);
    await expect(publishing.rollback(first.id, 'no_global_delete')).resolves.toMatchObject({ status: 'conflict', productRestored: true });
    expect(live.mediaIds).toEqual(['gid://shopify/MediaImage/50']);
    expect(live.variants.every((variant) => variant.mediaIds[0] === 'gid://shopify/MediaImage/50')).toBe(true);
    expect((await readdir(path.join(root, 'publications', first.id))).filter((name) => name.endsWith('.json')).length).toBeGreaterThan(firstCheckpointCount);
    expect(api.createImageFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['partial', (api: any) => api.waitForFileReady.mockRejectedValueOnce(new Error('processing failed'))],
    ['conflict', (api: any) => api.createImageFile.mockRejectedValueOnce(new Error('creation result unknown'))]
  ])('keeps a %s operation blocking a new publication', async (_status, fail) => {
    const { batch, background, batches, api, publishing } = await fixture();
    fail(api);
    const unresolved = await publishing.publish(batch.id);
    expect(['partial', 'conflict']).toContain(unresolved.status);
    const nextBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    await expect(publishing.validate(nextBatch.id)).resolves.toMatchObject({ ready: false, errors: [expect.stringContaining(unresolved.id)] });
    await expect(publishing.publish(nextBatch.id)).rejects.toBeInstanceOf(PublicationError);
  });

  it('serializes concurrent publication startup so only one operation checkpoint is created', async () => {
    const { background, batches, api, publishing } = await fixture();
    const firstBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    const secondBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    api.stageImage.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return 'https://staged.example/image'; });
    const results = await Promise.allSettled([publishing.publish(firstBatch.id), publishing.publish(secondBatch.id)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(publishing.list()).toHaveLength(1);
  });

  it('keeps an in-process blocker when initial checkpoint persistence fails before Shopify mutation', async () => {
    const { background, batches, batch, api, publishing } = await fixture();
    const originalCheckpoint = (publishing as any).checkpoint.bind(publishing);
    (publishing as any).checkpoint = vi.fn().mockRejectedValueOnce(new Error('checkpoint disk unavailable')).mockImplementation(originalCheckpoint);
    await expect(publishing.publish(batch.id)).rejects.toThrow('checkpoint disk unavailable');
    expect(publishing.list()).toMatchObject([{ status: 'conflict', errors: [expect.stringMatching(/checkpoint persistence failed/)] }]);
    expect(api.stageImage).not.toHaveBeenCalled();
    const nextBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    await expect(publishing.publish(nextBatch.id)).rejects.toBeInstanceOf(PublicationError);
  });

  it('preserves completed-product republish blocking after restart without impairing rollback', async () => {
    const { root, assets, background, batches, batch, api, publishing } = await fixture();
    const first = await publishing.publish(batch.id);
    const secondBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    await expect(recovered.publish(secondBatch.id)).rejects.toMatchObject({ status: 409 });
    await expect(recovered.validate(secondBatch.id)).resolves.toMatchObject({ ready: false });
    await expect(recovered.rollback(first.id, 'no_global_delete')).resolves.toMatchObject({ productRestored: true });
  });

  it('replaces an allowlisted 80-variant gallery with one generated image per color and fully restores it', async () => {
    const { batch, api, publishing, live } = await fixture({}, largeProduct, [largeProduct.id]);
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({
      ready: true, imageCount: 8, variantCount: 80, currentGalleryImageCount: 8, expectedFinalGalleryImageCount: 8,
      confirmationText: `PUBLISH ${largeProduct.id}`, replacesGallery: true
    });
    await expect(publishing.publish(batch.id, 'PUBLISH')).rejects.toBeInstanceOf(PublicationError);
    const published = await publishing.publish(batch.id, `PUBLISH ${largeProduct.id}`);
    expect(published).toMatchObject({ status: 'published', publicationMode: 'replace_gallery' });
    expect(live.mediaIds).toEqual(largeColors.map((_color, index) => `gid://shopify/MediaImage/${100 + index}`));
    expect(new Set(live.variants.map((variant) => variant.mediaIds[0]))).toEqual(new Set(live.mediaIds));
    for (let colorIndex = 0; colorIndex < largeColors.length; colorIndex += 1) {
      const expectedMedia = `gid://shopify/MediaImage/${100 + colorIndex}`;
      expect(live.variants.filter((variant) => variant.color === largeColors[colorIndex]).every((variant) => variant.mediaIds[0] === expectedMedia)).toBe(true);
    }
    expect(api.removeFileFromProduct).toHaveBeenCalledTimes(8);
    expect(api.deleteFile).not.toHaveBeenCalled();

    const rolledBack = await publishing.rollback(published.id, 'no_global_delete');
    expect(rolledBack).toMatchObject({ status: 'conflict', productRestored: true, rollbackMode: 'no_global_delete' });
    expect(live.mediaIds).toEqual(largeColors.map((_color, index) => `gid://shopify/MediaImage/${50 + index}`));
    for (let colorIndex = 0; colorIndex < largeColors.length; colorIndex += 1) {
      const originalMedia = `gid://shopify/MediaImage/${50 + colorIndex}`;
      expect(live.variants.filter((variant) => variant.color === largeColors[colorIndex]).every((variant) => variant.mediaIds[0] === originalMedia)).toBe(true);
    }
  });

  it('recovers an interrupted original-reference removal without repeating the mutation', async () => {
    const { batch, api, publishing, live } = await fixture();
    api.removeFileFromProduct.mockImplementationOnce(async (mediaId: string) => {
      live.mediaIds = live.mediaIds.filter((id) => id !== mediaId);
      throw new Error('connection lost after reference removal');
    });
    const partial = await publishing.publish(batch.id);
    expect(partial).toMatchObject({ status: 'partial', items: [{ intent: 'remove_original_reference' }] });
    await expect(publishing.resume(partial.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.removeFileFromProduct).toHaveBeenCalledOnce();
    expect(live.mediaIds).toEqual(['gid://shopify/MediaImage/99']);
  });

  it('rejects new publication for products outside the server-side allowlist', async () => {
    const productionProduct = { ...product, id: 'gid://shopify/Product/999', title: 'Production Shirt', status: 'ACTIVE' };
    const { batch, publishing, api } = await fixture({ getProduct: vi.fn().mockResolvedValue(productionProduct) });
    api.getProduct.mockResolvedValue(productionProduct);
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: false, errors: expect.arrayContaining([expect.stringMatching(/allowlist/)]) });
    await expect(publishing.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.createImageFile).not.toHaveBeenCalled();
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

  it('restores original ordering and deliberately retains generated files', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    const rolledBack = await publishing.rollback(published.id, 'no_global_delete');
    expect(rolledBack).toMatchObject({ status: 'conflict', productRestored: true, rollbackMode: 'no_global_delete', items: [{
      cleanupPending: true, cleanupOutcome: { kind: 'retained_by_operator', reasonCode: 'global_deletion_prohibited_by_operator', mediaId: 'gid://shopify/MediaImage/99' }
    }] });
    expect(api.detachVariantMedia).not.toHaveBeenCalled(); expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
    expect(api.replaceVariantMedia).toHaveBeenLastCalledWith(product.id, 'gid://shopify/MediaImage/50', product.variants.map((variant) => variant.id));
    expect(api.reorderMedia).toHaveBeenCalledWith(product.id, ['gid://shopify/MediaImage/50']);
  });

  it('never reaches deletion methods during rollback or after restart', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    const conflicted = await publishing.rollback(published.id, 'no_global_delete');
    expect(conflicted).toMatchObject({ status: 'conflict', conflictKinds: ['retained_file_deletion_prohibited'], productRestored: true });
    expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(published.id)).toMatchObject({ status: 'conflict', rollbackMode: 'no_global_delete', productRestored: true });
    await expect(recovered.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({ status: 'conflict', productRestored: true });
    expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('blocks rollback when external Shopify media changes are detected', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    api.getPublicationState.mockResolvedValueOnce({ complete: true, mediaIds: ['gid://shopify/MediaImage/50', 'gid://shopify/MediaImage/99', 'gid://shopify/MediaImage/777'], variants: [] });
    const result = await publishing.rollback(published.id, 'no_global_delete');
    expect(result.status).toBe('conflict'); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('does not retry an uncertain file creation result', async () => {
    const create = vi.fn().mockRejectedValue(new Error('connection lost after request'));
    const { batch, publishing } = await fixture({ createImageFile: create });
    await expect(publishing.publish(batch.id)).resolves.toMatchObject({ status: 'conflict', items: [{ uncertainCreation: true }] });
    await expect(publishing.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(create).toHaveBeenCalledOnce();
  });

  it('recovers a crash after fileCreate success as an uncertain-creation conflict without duplicating the file', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const completed = await publishing.publish(batch.id);
    const directory = path.join(root, 'publications', completed.id);
    const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    const interrupted = structuredClone(completed);
    interrupted.status = 'publishing'; interrupted.expectedPublishedMediaOrder = [...interrupted.originalMediaOrder];
    interrupted.completedSteps = []; interrupted.items[0].createdMediaId = undefined; interrupted.items[0].intent = 'create_file'; interrupted.items[0].status = 'pending';
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json`), JSON.stringify(interrupted));

    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(completed.id)).toMatchObject({ status: 'conflict', items: [{ uncertainCreation: true, intent: 'create_file' }] });
    await expect(recovered.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('recovers an interrupted fileDelete intent as uncertain and never repeats deletion', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id); const directory = path.join(root, 'publications', operation.id);
    const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    const interrupted = structuredClone(operation); interrupted.status = 'rolling_back'; interrupted.items[0].intent = 'delete_file'; interrupted.items[0].status = 'rolled_back';
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json`), JSON.stringify(interrupted));
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(operation.id)).toMatchObject({ status: 'conflict', items: [{ cleanupOutcome: { kind: 'cleanup_outcome_uncertain', phase: 'file_delete' } }] });
    await expect(recovered.rollback(operation.id, 'no_global_delete')).rejects.toBeInstanceOf(PublicationError);
    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('fails closed when an existing partial operation retains create_file intent without a media ID', async () => {
    const { batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id);
    const stored = publishing.get(operation.id);
    stored.status = 'partial'; stored.expectedPublishedMediaOrder = [...stored.originalMediaOrder]; stored.completedSteps = [];
    stored.items[0].createdMediaId = undefined; stored.items[0].intent = 'create_file'; stored.items[0].status = 'pending';
    await expect(publishing.resume(operation.id, batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('reconciles live state before retrying a partial association', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.replaceVariantMedia.mockRejectedValueOnce(new Error('temporary failure')).mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => {
      for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = [mediaId];
    });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    const partial = publishing.list()[0]; partial.items[0].intent = 'append_variants';
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce();
    expect(api.addFileToProduct).toHaveBeenCalledOnce();
  });

  it('reconciles an interrupted successful replacement without repeating the mutation', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.replaceVariantMedia.mockImplementationOnce(async (_productId: string, mediaId: string, variantIds: string[]) => {
      for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = [mediaId];
      throw new Error('connection lost after replacement');
    });
    const operation = await publishing.publish(batch.id);
    expect(operation).toMatchObject({ status: 'partial', items: [{ intent: 'replace_variants' }] });
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.replaceVariantMedia).toHaveBeenCalledOnce();
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('blocks recovery when only some variants reflect a pending replacement', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.replaceVariantMedia.mockImplementationOnce(async (_productId: string, mediaId: string) => {
      live.variants[0].mediaIds = [mediaId];
      throw new Error('partial state observed');
    });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'conflict' });
    expect(api.replaceVariantMedia).toHaveBeenCalledOnce();
  });

  it('reconciles an interrupted rollback replacement without repeating it', async () => {
    const { batch, publishing, api, live } = await fixture();
    const published = await publishing.publish(batch.id);
    api.replaceVariantMedia.mockImplementationOnce(async (_productId: string, mediaId: string, variantIds: string[]) => {
      for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = [mediaId];
      throw new Error('connection lost after original association was restored');
    });
    await expect(publishing.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({ status: 'rollback_partial' });
    await expect(publishing.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({ status: 'conflict', productRestored: true });
    expect(api.replaceVariantMedia).toHaveBeenCalledTimes(2);
    expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('reconciles an interrupted generated-reference removal without deletion or duplicate removal', async () => {
    const { batch, publishing, api, live } = await fixture();
    const published = await publishing.publish(batch.id);
    vi.clearAllMocks();
    api.getPublicationState.mockImplementation(async () => structuredClone(live));
    api.removeFileFromProduct.mockImplementationOnce(async (mediaId: string) => {
      live.mediaIds = live.mediaIds.filter((id) => id !== mediaId);
      throw new Error('connection lost after generated reference removal');
    });
    await expect(publishing.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({ status: 'rollback_partial' });
    await expect(publishing.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({
      status: 'conflict', productRestored: true, items: [{ cleanupOutcome: { kind: 'retained_by_operator' } }]
    });
    expect(api.removeFileFromProduct).toHaveBeenCalledOnce();
    expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('safely retries failures before staging and product-reference mutation boundaries', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.stageImage.mockRejectedValueOnce(new Error('staging unavailable')).mockResolvedValue('https://staged.example/image');
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    api.addFileToProduct.mockRejectedValueOnce(new Error('reference unavailable')).mockImplementation(async (id: string) => { if (!live.mediaIds.includes(id)) live.mediaIds.push(id); });
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'partial' });
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it('reconciles an asynchronously completed reorder without repeating it', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.reorderMedia.mockRejectedValueOnce(new Error('order job unavailable')).mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce();
    expect(api.replaceVariantMedia).toHaveBeenCalledOnce();
    expect(api.reorderMedia).toHaveBeenCalledOnce();
  });

  it('keeps historical append-style operation semantics when publicationMode is absent', async () => {
    const { batch, publishing, live } = await fixture();
    const published = await publishing.publish(batch.id);
    const historical = publishing.get(published.id);
    historical.status = 'partial';
    delete historical.publicationMode;
    historical.expectedPublishedMediaOrder = ['gid://shopify/MediaImage/50', 'gid://shopify/MediaImage/99'];
    live.mediaIds = [...historical.expectedPublishedMediaOrder];
    await expect(publishing.resume(historical.id, batch.id)).resolves.toMatchObject({
      status: 'published', expectedPublishedMediaOrder: ['gid://shopify/MediaImage/50', 'gid://shopify/MediaImage/99']
    });
  });

  it('validates an existing partial operation separately and resumes it without creating a duplicate operation', async () => {
    const { batch, publishing, api } = await fixture();
    api.reorderMedia.mockRejectedValueOnce(new Error('order job unavailable'));
    const operation = await publishing.publish(batch.id);

    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: false, errors: expect.arrayContaining([expect.stringContaining(operation.id)]) });
    await expect(publishing.validateRecovery(operation.id, batch.id)).resolves.toMatchObject({
      eligible: true, operationId: operation.id, batchId: batch.id, imageCount: 1, variantCount: 2
    });
    await expect(publishing.publish(batch.id)).rejects.toBeInstanceOf(PublicationError);
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published', id: operation.id });
    expect(publishing.list()).toHaveLength(1);
    await expect(publishing.resume(operation.id, batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.createImageFile).toHaveBeenCalledOnce();
    expect(api.replaceVariantMedia).toHaveBeenCalledOnce();
  });

  it('rejects recovery readiness for the wrong batch and for an abandoned operation', async () => {
    const { batch, publishing, api } = await fixture();
    api.reorderMedia.mockRejectedValueOnce(new Error('order job unavailable'));
    const operation = await publishing.publish(batch.id);
    const wrongBatch = '00000000-0000-4000-8000-000000000000';
    await expect(publishing.validateRecovery(operation.id, wrongBatch)).resolves.toMatchObject({ eligible: false, errors: [expect.stringMatching(/batch/i)] });
    publishing.get(operation.id).status = 'abandoned';
    await expect(publishing.validateRecovery(operation.id, batch.id)).resolves.toMatchObject({ eligible: false, errors: [expect.stringMatching(/abandoned/i)] });
  });

  it('reconciles an interrupted reorder when the expected live order already completed', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.reorderMedia.mockImplementationOnce(async () => { live.mediaIds = ['gid://shopify/MediaImage/99']; throw new Error('job polling failed'); })
      .mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; });
    const operation = await publishing.publish(batch.id);
    expect(operation).toMatchObject({ status: 'partial', items: [{ intent: 'reorder_published' }] });
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce(); expect(api.replaceVariantMedia).toHaveBeenCalledOnce(); expect(api.reorderMedia).toHaveBeenCalledOnce();
  });

  it('fails closed on unexpected media while reconciling interrupted reordering', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.reorderMedia.mockRejectedValueOnce(new Error('job polling failed'));
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('partial');
    live.mediaIds.push('gid://shopify/MediaImage/777');
    await expect(publishing.validateRecovery(operation.id, batch.id)).resolves.toMatchObject({ eligible: false, errors: [expect.stringMatching(/externally/i)] });
    await expect(publishing.resume(operation.id, batch.id)).rejects.toBeInstanceOf(PublicationError);
    expect(api.reorderMedia).toHaveBeenCalledOnce(); expect(api.createImageFile).toHaveBeenCalledOnce(); expect(api.replaceVariantMedia).toHaveBeenCalledOnce();
  });

  it.each([
    ['duplicate product media', (state: any) => { state.mediaIds.push(state.mediaIds[0]); }, /duplicate IDs/],
    ['duplicate variant identity', (state: any) => { state.variants.push(structuredClone(state.variants[0])); }, /duplicate IDs/],
    ['duplicate variant association', (state: any) => { state.variants[0].mediaIds.push(state.variants[0].mediaIds[0]); }, /duplicate associations/]
  ])('rejects partial recovery with %s in the complete Shopify snapshot', async (_name, mutate, message) => {
    const { batch, publishing, api, live } = await fixture();
    api.waitForFileReady.mockRejectedValueOnce(new Error('processing interrupted'));
    const operation = await publishing.publish(batch.id);
    mutate(live);
    const readiness = await publishing.validateRecovery(operation.id, batch.id);
    expect(readiness.eligible).toBe(false); expect(readiness.errors.join(' ')).toMatch(message);
    await expect(publishing.resume(operation.id, batch.id)).rejects.toBeInstanceOf(PublicationError);
  });

  it('does not declare publication successful when final readback contains duplicate media evidence', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.reorderMedia.mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids, ids[0]]; });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('conflict');
    expect(operation.errors.join(' ')).toMatch(/duplicate IDs/);
  });

  it('rejects external variant-media changes before rollback', async () => {
    const { batch, publishing, api, live } = await fixture();
    const published = await publishing.publish(batch.id);
    live.variants[0].mediaIds.push('gid://shopify/MediaImage/777');
    await expect(publishing.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({ status: 'conflict' });
    expect(api.detachVariantMedia).not.toHaveBeenCalled();
  });

  it('preserves a created file because global deletion is explicitly prohibited', async () => {
    const { batch, publishing, api } = await fixture();
    const published = await publishing.publish(batch.id);
    await expect(publishing.rollback(published.id, 'no_global_delete')).resolves.toMatchObject({
      status: 'conflict', productRestored: true, cleanupConflicts: [expect.stringContaining('deliberately retained')]
    });
    expect(api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('records a machine-readable deliberate-retention outcome even when deletion would otherwise be reported safe', async () => {
    const retained = await fixture();
    const published = await retained.publishing.publish(retained.batch.id);
    retained.api.verifyFileDeletionSafe.mockResolvedValue({ safe: true, reason: 'operation-owned' });
    const operation = await retained.publishing.rollback(published.id, 'no_global_delete');
    expect(operation.items[0].cleanupOutcome).toMatchObject({ kind: 'retained_by_operator', reasonCode: 'global_deletion_prohibited_by_operator', mediaId: 'gid://shopify/MediaImage/99' });
    expect(retained.api.verifyFileDeletionSafe).not.toHaveBeenCalled(); expect(retained.api.deleteFile).not.toHaveBeenCalled();
  });

  it('verifies and finalizes a restored product while retaining generated files without Shopify mutations', async () => {
    const { root, operation, publishing, api } = await retainedRollbackFixture();
    const readiness = await publishing.validateRollbackFinalization(operation.id);
    expect(readiness).toMatchObject({ eligible: true, retainedFileCount: 1, evidence: {
      snapshotComplete: true, originalMediaIdsVerified: ['gid://shopify/MediaImage/50'], retainedGeneratedMediaIds: ['gid://shopify/MediaImage/99']
    } });
    expect(readiness.evidence?.originalVariantAssociationsVerified).toEqual(product.variants.map((variant) => ({ variantId: variant.id, mediaIds: ['gid://shopify/MediaImage/50'] })));
    const before = (await readdir(path.join(root, 'publications', operation.id))).filter((name) => name.endsWith('.json')).length;
    const confirmation = `FINALIZE ${operation.id} FILES RETAINED`;
    const finalized = await publishing.finalizeRollback(operation.id, confirmation);
    expect(finalized).toMatchObject({ status: 'rolled_back_files_retained', rollbackFinalizationEvidence: {
      previousStatus: 'conflict', newStatus: 'rolled_back_files_retained', confirmation,
      cleanupReason: 'global_deletion_prohibited_by_operator', retainedGeneratedMediaIds: ['gid://shopify/MediaImage/99']
    }, items: [{ cleanupPending: false, cleanupDisposition: 'retained_manual_ownership_review' }] });
    expect((await readdir(path.join(root, 'publications', operation.id))).filter((name) => name.endsWith('.json'))).toHaveLength(before + 1);
    expect(api.stageImage).not.toHaveBeenCalled(); expect(api.createImageFile).not.toHaveBeenCalled(); expect(api.addFileToProduct).not.toHaveBeenCalled();
    expect(api.replaceVariantMedia).not.toHaveBeenCalled(); expect(api.removeFileFromProduct).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled(); expect(api.reorderMedia).not.toHaveBeenCalled();
    await expect(publishing.finalizeRollback(operation.id, confirmation)).rejects.toBeInstanceOf(PublicationError);
  });

  it('preserves finalization support for historical ownership-unproven retention evidence', async () => {
    const { operation, publishing } = await retainedRollbackFixture();
    const stored = publishing.get(operation.id);
    stored.items[0].cleanupOutcome = {
      kind: 'retained_ownership_unproven', mediaId: stored.items[0].createdMediaId!, recordedAt: new Date().toISOString(),
      reasonCode: 'global_references_unverifiable', reason: 'Historical adapter could not enumerate global references.'
    };
    stored.conflictKinds = ['retained_file_ownership_unproven'];
    const readiness = await publishing.validateRollbackFinalization(operation.id);
    expect(readiness).toMatchObject({ eligible: true, evidence: { cleanupReason: 'global_file_deletion_ownership_unproven' } });
  });

  it('finalizes a completely restored allowlisted real product without deleting retained global files', async () => {
    const { operation, publishing, api } = await retainedRollbackFixture(productionProduct, [productionProduct.id]);
    await expect(publishing.validateRollbackFinalization(operation.id)).resolves.toMatchObject({ eligible: true, productId: productionProduct.id });
    const confirmation = `FINALIZE ${operation.id} FILES RETAINED`;
    await expect(publishing.finalizeRollback(operation.id, confirmation)).resolves.toMatchObject({ status: 'rolled_back_files_retained' });
    expect(api.deleteFile).not.toHaveBeenCalled();
    expect(api.addFileToProduct).not.toHaveBeenCalled();
    expect(api.removeFileFromProduct).not.toHaveBeenCalled();
    expect(api.replaceVariantMedia).not.toHaveBeenCalled();
  });

  it('rejects retained-file finalization for a real product when the server allowlist is absent', async () => {
    const { root, assets, batches, operation, api } = await retainedRollbackFixture(productionProduct, [productionProduct.id]);
    const withoutAllowlist = new PublishingService(root, assets, batches, api as any); await withoutAllowlist.init();
    await expect(withoutAllowlist.validateRollbackFinalization(operation.id)).resolves.toMatchObject({ eligible: false, errors: [expect.stringMatching(/allowlisted/) ] });
    expect(api.getPublicationState).not.toHaveBeenCalled();
  });

  it('requires the exact operation-specific retained-files confirmation', async () => {
    const { operation, publishing, api } = await retainedRollbackFixture();
    await expect(publishing.finalizeRollback(operation.id, 'FINALIZE')).rejects.toBeInstanceOf(PublicationError);
    expect(api.getPublicationState).not.toHaveBeenCalled();
  });

  it('fails closed for legacy unfinalized cleanup conflicts but keeps historical finalized checkpoints terminal and readable', async () => {
    const legacy = await retainedRollbackFixture(); delete legacy.publishing.get(legacy.operation.id).items[0].cleanupOutcome;
    const readiness = await legacy.publishing.validateRollbackFinalization(legacy.operation.id);
    expect(readiness.eligible).toBe(false); expect(readiness.errors.join(' ')).toMatch(/machine-readable|Legacy/);
    expect(legacy.api.getPublicationState).not.toHaveBeenCalled();

    const finalized = await retainedRollbackFixture(); const confirmation = `FINALIZE ${finalized.operation.id} FILES RETAINED`;
    const terminal = await finalized.publishing.finalizeRollback(finalized.operation.id, confirmation);
    const directory = path.join(finalized.root, 'publications', terminal.id); const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    const historical = structuredClone(terminal); delete historical.items[0].cleanupOutcome;
    historical.rollbackFinalizationEvidence!.cleanupReason = 'global_file_deletion_ownership_unproven';
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json`), JSON.stringify(historical));
    const recovered = new PublishingService(finalized.root, finalized.assets, finalized.batches, finalized.api as any); await recovered.init();
    expect(recovered.get(terminal.id)).toMatchObject({ status: 'rolled_back_files_retained', rollbackFinalizationEvidence: { cleanupReason: 'global_file_deletion_ownership_unproven' } });
    await expect(recovered.rollback(terminal.id, 'no_global_delete')).rejects.toBeInstanceOf(PublicationError);
  });

  it.each([
    ['missing original media', (state: any) => { state.mediaIds = []; }, /media IDs or ordering/],
    ['unexpected extra media', (state: any) => { state.mediaIds.push('gid://shopify/MediaImage/777'); }, /media IDs or ordering/],
    ['missing variant', (state: any) => { state.variants.pop(); }, /variant set|missing/],
    ['unexpected variant', (state: any) => { state.variants.push({ id: 'gid://shopify/ProductVariant/777', mediaIds: [] }); }, /variant set|unexpected/],
    ['changed variant association', (state: any) => { state.variants[0].mediaIds = []; }, /association/],
    ['incomplete pagination', (state: any) => { state.complete = false; }, /incomplete/],
    ['duplicate product media', (state: any) => { state.mediaIds.push(state.mediaIds[0]); }, /duplicate IDs/],
    ['duplicate variant identity', (state: any) => { state.variants.push(structuredClone(state.variants[0])); }, /duplicate IDs/],
    ['duplicate variant media', (state: any) => { state.variants[0].mediaIds.push(state.variants[0].mediaIds[0]); }, /duplicate associations/]
  ])('rejects rollback finalization when live state has %s', async (_name, mutate, message) => {
    const { operation, publishing, api, live } = await retainedRollbackFixture();
    const changed = structuredClone(live); mutate(changed); api.getPublicationState.mockResolvedValueOnce(changed);
    const readiness = await publishing.validateRollbackFinalization(operation.id);
    expect(readiness.eligible).toBe(false); expect(readiness.errors.join(' ')).toMatch(message);
  });

  it('rejects missing cleanup evidence and unrelated operation errors without reading Shopify', async () => {
    const missing = await retainedRollbackFixture(); missing.publishing.get(missing.operation.id).items[0].cleanupPending = false;
    expect((await missing.publishing.validateRollbackFinalization(missing.operation.id)).errors.join(' ')).toMatch(/cleanup-pending/);
    expect(missing.api.getPublicationState).not.toHaveBeenCalled();
    const unrelated = await retainedRollbackFixture(); unrelated.publishing.get(unrelated.operation.id).errors.push('Unrelated restoration failure');
    expect((await unrelated.publishing.validateRollbackFinalization(unrelated.operation.id)).errors.join(' ')).toMatch(/unresolved errors/);
    expect(unrelated.api.getPublicationState).not.toHaveBeenCalled();
  });

  it('serializes finalization and keeps a completed Release 1 product ineligible afterward', async () => {
    const { operation, publishing, api, batch, batches, background } = await retainedRollbackFixture();
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: false });
    api.getPublicationState.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return structuredClone({ complete: true, mediaIds: ['gid://shopify/MediaImage/50'], variants: product.variants.map((variant) => ({ id: variant.id, color: variant.color, mediaIds: ['gid://shopify/MediaImage/50'] })) }); });
    const confirmation = `FINALIZE ${operation.id} FILES RETAINED`;
    const [first, second] = await Promise.allSettled([publishing.finalizeRollback(operation.id, confirmation), publishing.finalizeRollback(operation.id, confirmation)]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const freshBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    await expect(publishing.validate(freshBatch.id)).resolves.toMatchObject({ ready: false, errors: [expect.stringMatching(/already processed/)] });
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

  it('fails startup instead of falling back past a contradictory complete checkpoint', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id); const directory = path.join(root, 'publications', operation.id);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
    const contradictory = structuredClone(operation);
    contradictory.items.push({ ...structuredClone(contradictory.items[0]), color: contradictory.items[0].color });
    await writeFile(path.join(directory, `${String(files.length).padStart(6, '0')}.json`), JSON.stringify(contradictory));
    const recovered = new PublishingService(root, assets, batches, api as any);
    await expect(recovered.init()).rejects.toThrow(/checkpoint integrity.*duplicate item ownership/i);
    expect(api.createImageFile).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing required field', (checkpoint: any) => { delete checkpoint.productTitle; }, /required fields or field types/],
    ['invalid operation version', (checkpoint: any) => { checkpoint.version = 2; }, /required fields or field types/],
    ['invalid operation status', (checkpoint: any) => { checkpoint.status = 'successful'; }, /invalid operation status/],
    ['wrong operation ID', (checkpoint: any) => { checkpoint.id = '22222222-2222-4222-8222-222222222222'; }, /operation ID does not match/],
    ['contradictory variant ownership', (checkpoint: any) => { checkpoint.items.push({ ...structuredClone(checkpoint.items[0]), color: 'Navy' }); }, /duplicate item ownership/],
    ['invalid field type', (checkpoint: any) => { checkpoint.items[0].variantIds = 'not-an-array'; }, /required fields or field types/],
    ['Task 019 schema without provenance', (checkpoint: any) => { delete checkpoint.items[0].sourceProvenance; }, /incomplete source-integrity evidence/]
  ])('fails closed without fallback, rewrite, or Shopify mutation for a complete checkpoint with %s', async (_name, mutate, diagnostic) => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id); const directory = path.join(root, 'publications', operation.id);
    const before = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).length;
    const invalid = structuredClone(operation); mutate(invalid);
    await writeFile(path.join(directory, `${String(before).padStart(6, '0')}.json`), JSON.stringify(invalid));
    vi.clearAllMocks();
    const recovered = new PublishingService(root, assets, batches, api as any);
    await expect(recovered.init()).rejects.toThrow(diagnostic);
    expect(recovered.list()).toEqual([]);
    expect((await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name))).toHaveLength(before + 1);
    expect(api.stageImage).not.toHaveBeenCalled(); expect(api.createImageFile).not.toHaveBeenCalled(); expect(api.addFileToProduct).not.toHaveBeenCalled();
    expect(api.replaceVariantMedia).not.toHaveBeenCalled(); expect(api.removeFileFromProduct).not.toHaveBeenCalled(); expect(api.reorderMedia).not.toHaveBeenCalled();
  });

  it('loads a valid historical checkpoint without Task 019 provenance and does not rewrite it', async () => {
    const { root, assets, batches, batch, api, publishing } = await fixture();
    const operation = await publishing.publish(batch.id); const directory = path.join(root, 'publications', operation.id);
    const before = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).length;
    const historical = structuredClone(operation);
    delete historical.sourceValidationSchemaVersion;
    for (const item of historical.items) { delete item.sourceProvenance; delete item.generationEvidence; }
    await writeFile(path.join(directory, `${String(before).padStart(6, '0')}.json`), JSON.stringify(historical));
    vi.clearAllMocks();
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(operation.id)).toMatchObject({ id: operation.id, status: 'published' });
    expect((await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name))).toHaveLength(before + 1);
    expect(api.createImageFile).not.toHaveBeenCalled(); expect(api.replaceVariantMedia).not.toHaveBeenCalled();
  });

  it('verifies and durably abandons a manually restored partial test operation', async () => {
    const { root, operation, publishing, api } = await restoredPartialFixture();
    const readiness = await publishing.validateAbandonment(operation.id);
    expect(readiness).toMatchObject({ eligible: true, evidence: { snapshotComplete: true, generatedMediaIdsChecked: ['gid://shopify/MediaImage/99'] } });
    const before = (await readdir(path.join(root, 'publications', operation.id))).filter((name) => name.endsWith('.json')).length;
    const abandoned = await publishing.abandon(operation.id, 'Manual restoration verified for disposable test reset');
    const after = (await readdir(path.join(root, 'publications', operation.id))).filter((name) => name.endsWith('.json')).length;
    expect(abandoned).toMatchObject({ status: 'abandoned', abandonmentReason: 'Manual restoration verified for disposable test reset' });
    expect(abandoned.abandonedAt).toBeTruthy(); expect(abandoned.abandonmentEvidence?.mediaIds).toEqual(['gid://shopify/MediaImage/50']);
    expect(after).toBe(before + 1); expect(api.removeFileFromProduct).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('rejects abandonment when generated media still references the product', async () => {
    const { operation, publishing, live } = await restoredPartialFixture();
    live.mediaIds.push('gid://shopify/MediaImage/99');
    const readiness = await publishing.validateAbandonment(operation.id);
    expect(readiness.eligible).toBe(false); expect(readiness.errors.join(' ')).toMatch(/Generated media remains/);
  });

  it('rejects abandonment for unexpected product media or changed variant associations', async () => {
    const first = await restoredPartialFixture(); first.live.mediaIds.push('gid://shopify/MediaImage/777');
    expect((await first.publishing.validateAbandonment(first.operation.id)).errors.join(' ')).toMatch(/ordering/);
    const second = await restoredPartialFixture(); second.live.variants[0].mediaIds = [];
    expect((await second.publishing.validateAbandonment(second.operation.id)).errors.join(' ')).toMatch(/media association changed/);
  });

  it('rejects abandonment when variants are missing or added', async () => {
    const missing = await restoredPartialFixture(); missing.live.variants.pop();
    expect((await missing.publishing.validateAbandonment(missing.operation.id)).errors.join(' ')).toMatch(/variant set|missing/);
    const added = await restoredPartialFixture(); added.live.variants.push({ id: 'gid://shopify/ProductVariant/777', color: 'Black', mediaIds: ['gid://shopify/MediaImage/50'] });
    expect((await added.publishing.validateAbandonment(added.operation.id)).errors.join(' ')).toMatch(/variant set|missing/);
  });

  it('rejects abandonment when Shopify cannot provide a complete snapshot', async () => {
    const { operation, publishing, api, live } = await restoredPartialFixture();
    api.getPublicationState.mockResolvedValueOnce({ ...structuredClone(live), complete: false });
    expect((await publishing.validateAbandonment(operation.id)).errors.join(' ')).toMatch(/incomplete/);
  });

  it('makes duplicate abandonment idempotent without another checkpoint or Shopify read', async () => {
    const { root, operation, publishing, api } = await restoredPartialFixture();
    const first = await publishing.abandon(operation.id, 'Manual restoration verified for disposable test reset');
    const directory = path.join(root, 'publications', operation.id); const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    vi.clearAllMocks(); const second = await publishing.abandon(operation.id, 'Duplicate request is safely ignored');
    expect(second).toEqual(first); expect((await readdir(directory)).filter((name) => name.endsWith('.json'))).toHaveLength(count);
    expect(api.getPublicationState).not.toHaveBeenCalled();
  });

  it('ignores an interrupted abandonment checkpoint and can safely retry', async () => {
    const { root, assets, batches, operation, api } = await restoredPartialFixture(); const directory = path.join(root, 'publications', operation.id);
    const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json.partial.tmp`), '{"status":"abandoned"');
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json`), '{"status":');
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    expect(recovered.get(operation.id).status).toBe('partial');
    await expect(recovered.abandon(operation.id, 'Retried after interrupted checkpoint write')).resolves.toMatchObject({ status: 'abandoned' });
  });

  it('blocks a fresh batch until every nonterminal operation on the test product is abandoned', async () => {
    const { root, assets, batches, batch, background, operation, api } = await restoredPartialFixture();
    const second = structuredClone(operation); second.id = '22222222-2222-4222-8222-222222222222'; second.batchId = '33333333-3333-4333-8333-333333333333';
    const secondDirectory = path.join(root, 'publications', second.id); await mkdir(secondDirectory, { recursive: true });
    await writeFile(path.join(secondDirectory, '000000.json'), JSON.stringify(second));
    const recovered = new PublishingService(root, assets, batches, api as any); await recovered.init();
    const freshBatch = await waitBatch(batches, (await batches.create(product.id, background.id)).id);
    await recovered.abandon(operation.id, 'First disposable test attempt manually restored');
    expect((await recovered.validate(freshBatch.id)).errors.join(' ')).toContain(second.id);
    await recovered.abandon(second.id, 'Second disposable test attempt manually restored');
    await expect(recovered.validate(freshBatch.id)).resolves.toMatchObject({ ready: true });
    expect(batch.id).not.toBe(freshBatch.id);
  });

  it('never offers abandonment for a production product operation', async () => {
    const { publishing, operation, api } = await restoredPartialFixture();
    const stored = publishing.get(operation.id); stored.productId = 'gid://shopify/Product/999';
    const readiness = await publishing.validateAbandonment(operation.id);
    expect(readiness).toMatchObject({ eligible: false }); expect(readiness.errors.join(' ')).toMatch(/designated disposable/);
    expect(api.getPublicationState).not.toHaveBeenCalled();
  });
});
