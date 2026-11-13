import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
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
  id: 'gid://shopify/Product/15608846975264', title: 'Mockup Automation - TEST ONLY', handle: 'test-shirt', status: 'DRAFT', colors: ['Black'], sizes: ['M', 'L'], images: [image],
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
    replaceVariantMedia: vi.fn().mockResolvedValue(undefined),
    detachVariantMedia: vi.fn().mockResolvedValue(undefined), reorderMedia: vi.fn().mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; }), deleteFile: vi.fn().mockResolvedValue(undefined),
    verifyFileDeletionSafe: vi.fn().mockResolvedValue({ safe: true, reason: 'operation-owned' }),
    ...overrides
  };
  api.appendVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id) && !variant.mediaIds.includes(mediaId)) variant.mediaIds.push(mediaId); });
  api.replaceVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = [mediaId]; });
  api.detachVariantMedia.mockImplementation(async (_productId: string, mediaId: string, variantIds: string[]) => { for (const variant of live.variants) if (variantIds.includes(variant.id)) variant.mediaIds = variant.mediaIds.filter((id) => id !== mediaId); });
  api.removeFileFromProduct.mockImplementation(async (mediaId: string) => { live.mediaIds = live.mediaIds.filter((id) => id !== mediaId); });
  const publishing = new PublishingService(root, assets, batches, api as any); await publishing.init();
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

async function retainedRollbackFixture() {
  const result = await fixture();
  const published = await result.publishing.publish(result.batch.id);
  result.api.verifyFileDeletionSafe.mockResolvedValueOnce({ safe: false, reason: 'global references cannot be proven exclusive', reasonCode: 'global_references_unverifiable' });
  const operation = await result.publishing.rollback(published.id);
  expect(operation).toMatchObject({ status: 'conflict', productRestored: true, items: [{ status: 'rolled_back', cleanupPending: true }] });
  vi.clearAllMocks();
  result.api.getProduct.mockResolvedValue(product);
  result.api.getPublicationState.mockImplementation(async () => structuredClone(result.live));
  return { ...result, operation };
}

describe('PublishingService', () => {
  it('validates and publishes all size variants for a color', async () => {
    const { batch, api, publishing } = await fixture();
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: true, imageCount: 1, variantCount: 2 });
    const operation = await publishing.publish(batch.id);
    expect(operation.status).toBe('published');
    expect(api.replaceVariantMedia).toHaveBeenCalledWith(product.id, 'gid://shopify/MediaImage/99', product.variants.map((variant) => variant.id));
    expect(api.appendVariantMedia).not.toHaveBeenCalled();
  });

  it('rejects new publication for products outside the designated disposable draft test product', async () => {
    const productionProduct = { ...product, id: 'gid://shopify/Product/999', title: 'Production Shirt', status: 'ACTIVE' };
    const { batch, publishing, api } = await fixture({ getProduct: vi.fn().mockResolvedValue(productionProduct) });
    api.getProduct.mockResolvedValue(productionProduct);
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: false, errors: [expect.stringMatching(/disposable draft test product/)] });
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

  it('rolls back created media and restores original ordering', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    const rolledBack = await publishing.rollback(published.id);
    expect(rolledBack.status).toBe('rolled_back');
    expect(api.detachVariantMedia).not.toHaveBeenCalled(); expect(api.deleteFile).toHaveBeenCalledWith('gid://shopify/MediaImage/99');
    expect(api.replaceVariantMedia).toHaveBeenLastCalledWith(product.id, 'gid://shopify/MediaImage/50', product.variants.map((variant) => variant.id));
    expect(api.reorderMedia).toHaveBeenCalledWith(product.id, ['gid://shopify/MediaImage/50']);
  });

  it('records an ambiguous file deletion and refuses an unsafe automatic retry', async () => {
    const { batch, api, publishing } = await fixture();
    const published = await publishing.publish(batch.id);
    api.deleteFile.mockRejectedValueOnce(new Error('Delete failed.'));
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'rollback_partial' });
    await expect(publishing.rollback(published.id)).rejects.toBeInstanceOf(PublicationError);
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
    await expect(recovered.rollback(operation.id)).rejects.toBeInstanceOf(PublicationError);
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
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'rollback_partial' });
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({ status: 'rolled_back' });
    expect(api.replaceVariantMedia).toHaveBeenCalledTimes(2);
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

  it('validates an existing partial operation separately and resumes it without creating a duplicate operation', async () => {
    const { batch, publishing, api } = await fixture();
    api.reorderMedia.mockRejectedValueOnce(new Error('order job unavailable'));
    const operation = await publishing.publish(batch.id);

    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: false, errors: [expect.stringContaining(operation.id)] });
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

  it('safely retries an interrupted reorder when live ordering has not completed', async () => {
    const { batch, publishing, api, live } = await fixture();
    api.reorderMedia.mockImplementationOnce(async () => { live.mediaIds = ['gid://shopify/MediaImage/99', 'gid://shopify/MediaImage/50']; throw new Error('job polling failed'); })
      .mockImplementation(async (_id: string, ids: string[]) => { live.mediaIds = [...ids]; });
    const operation = await publishing.publish(batch.id);
    expect(operation).toMatchObject({ status: 'partial', items: [{ intent: 'reorder_published' }] });
    await expect(publishing.resume(operation.id, batch.id)).resolves.toMatchObject({ status: 'published' });
    expect(api.createImageFile).toHaveBeenCalledOnce(); expect(api.replaceVariantMedia).toHaveBeenCalledOnce(); expect(api.reorderMedia).toHaveBeenCalledTimes(2);
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
    api.verifyFileDeletionSafe.mockResolvedValueOnce({ safe: false, reason: 'shared reference may exist', reasonCode: 'global_references_unverifiable' });
    await expect(publishing.rollback(published.id)).resolves.toMatchObject({
      status: 'conflict', productRestored: true, cleanupConflicts: [expect.stringContaining('generated file was preserved')]
    });
    expect(api.deleteFile).not.toHaveBeenCalled();
  });

  it('records machine-readable outcomes for safe deletion, retained files, cleanup failure, and uncertain deletion', async () => {
    const deleted = await fixture(); const deletedPublication = await deleted.publishing.publish(deleted.batch.id);
    await expect(deleted.publishing.rollback(deletedPublication.id)).resolves.toMatchObject({ items: [{ cleanupOutcome: { kind: 'deleted_safely', ownershipProof: 'exclusive_operation_ownership' } }] });

    const retained = await retainedRollbackFixture();
    expect(retained.operation.items[0].cleanupOutcome).toMatchObject({ kind: 'retained_ownership_unproven', reasonCode: 'global_references_unverifiable', mediaId: 'gid://shopify/MediaImage/99' });

    const failed = await fixture(); const failedPublication = await failed.publishing.publish(failed.batch.id);
    failed.api.verifyFileDeletionSafe.mockRejectedValueOnce(new Error('ownership registry unavailable'));
    await expect(failed.publishing.rollback(failedPublication.id)).resolves.toMatchObject({ status: 'rollback_partial', items: [{ cleanupOutcome: { kind: 'cleanup_failed', phase: 'ownership_verification' } }] });

    const uncertain = await fixture(); const uncertainPublication = await uncertain.publishing.publish(uncertain.batch.id);
    uncertain.api.deleteFile.mockRejectedValueOnce(new Error('connection lost after delete request'));
    await expect(uncertain.publishing.rollback(uncertainPublication.id)).resolves.toMatchObject({ status: 'rollback_partial', items: [{ cleanupOutcome: { kind: 'cleanup_outcome_uncertain', phase: 'file_delete' } }] });
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
      cleanupReason: 'global_file_deletion_ownership_unproven', retainedGeneratedMediaIds: ['gid://shopify/MediaImage/99']
    }, items: [{ cleanupPending: false, cleanupDisposition: 'retained_manual_ownership_review' }] });
    expect((await readdir(path.join(root, 'publications', operation.id))).filter((name) => name.endsWith('.json'))).toHaveLength(before + 1);
    expect(api.stageImage).not.toHaveBeenCalled(); expect(api.createImageFile).not.toHaveBeenCalled(); expect(api.addFileToProduct).not.toHaveBeenCalled();
    expect(api.replaceVariantMedia).not.toHaveBeenCalled(); expect(api.removeFileFromProduct).not.toHaveBeenCalled(); expect(api.deleteFile).not.toHaveBeenCalled(); expect(api.reorderMedia).not.toHaveBeenCalled();
    await expect(publishing.finalizeRollback(operation.id, confirmation)).rejects.toBeInstanceOf(PublicationError);
  });

  it('requires the exact operation-specific retained-files confirmation', async () => {
    const { operation, publishing, api } = await retainedRollbackFixture();
    await expect(publishing.finalizeRollback(operation.id, 'FINALIZE')).rejects.toBeInstanceOf(PublicationError);
    expect(api.getPublicationState).not.toHaveBeenCalled();
  });

  it('fails closed for legacy unfinalized cleanup conflicts but keeps historical finalized checkpoints terminal and readable', async () => {
    const legacy = await retainedRollbackFixture(); delete legacy.publishing.get(legacy.operation.id).items[0].cleanupOutcome;
    const readiness = await legacy.publishing.validateRollbackFinalization(legacy.operation.id);
    expect(readiness).toMatchObject({ eligible: false, errors: [expect.stringMatching(/machine-readable|Legacy/)] });
    expect(legacy.api.getPublicationState).not.toHaveBeenCalled();

    const finalized = await retainedRollbackFixture(); const confirmation = `FINALIZE ${finalized.operation.id} FILES RETAINED`;
    const terminal = await finalized.publishing.finalizeRollback(finalized.operation.id, confirmation);
    const directory = path.join(finalized.root, 'publications', terminal.id); const count = (await readdir(directory)).filter((name) => name.endsWith('.json')).length;
    const historical = structuredClone(terminal); delete historical.items[0].cleanupOutcome;
    await writeFile(path.join(directory, `${String(count).padStart(6, '0')}.json`), JSON.stringify(historical));
    const recovered = new PublishingService(finalized.root, finalized.assets, finalized.batches, finalized.api as any); await recovered.init();
    expect(recovered.get(terminal.id)).toMatchObject({ status: 'rolled_back_files_retained', rollbackFinalizationEvidence: { cleanupReason: 'global_file_deletion_ownership_unproven' } });
    await expect(recovered.rollback(terminal.id)).rejects.toBeInstanceOf(PublicationError);
  });

  it.each([
    ['missing original media', (state: any) => { state.mediaIds = []; }, /media IDs or ordering/],
    ['unexpected extra media', (state: any) => { state.mediaIds.push('gid://shopify/MediaImage/777'); }, /media IDs or ordering/],
    ['missing variant', (state: any) => { state.variants.pop(); }, /variant set|missing/],
    ['unexpected variant', (state: any) => { state.variants.push({ id: 'gid://shopify/ProductVariant/777', mediaIds: [] }); }, /variant set|unexpected/],
    ['changed variant association', (state: any) => { state.variants[0].mediaIds = []; }, /association/],
    ['incomplete pagination', (state: any) => { state.complete = false; }, /incomplete/]
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

  it('serializes finalization and allows future publication readiness only after terminal finalization', async () => {
    const { operation, publishing, api, batch } = await retainedRollbackFixture();
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: false });
    api.getPublicationState.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return structuredClone({ complete: true, mediaIds: ['gid://shopify/MediaImage/50'], variants: product.variants.map((variant) => ({ id: variant.id, color: variant.color, mediaIds: ['gid://shopify/MediaImage/50'] })) }); });
    const confirmation = `FINALIZE ${operation.id} FILES RETAINED`;
    const [first, second] = await Promise.allSettled([publishing.finalizeRollback(operation.id, confirmation), publishing.finalizeRollback(operation.id, confirmation)]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    await expect(publishing.validate(batch.id)).resolves.toMatchObject({ ready: true });
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
