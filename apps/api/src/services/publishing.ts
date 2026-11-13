import crypto from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MockupBatch, PublicationOperation, PublishReadiness } from '@mockup-automation/shared';
import { inspectImage } from './images.js';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import type { ShopifyService } from './shopify.js';

const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PublishingShopify = Pick<ShopifyService, 'getProduct' | 'getPublicationState' | 'stageImage' | 'createImageFile' | 'waitForFileReady' | 'addFileToProduct' | 'removeFileFromProduct' | 'appendVariantMedia' | 'detachVariantMedia' | 'reorderMedia' | 'deleteFile'>;

export class PublicationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class PublishingService {
  private readonly folder: string;
  private readonly records = new Map<string, PublicationOperation>();
  private readonly locks = new Set<string>();

  constructor(dataDir: string, private readonly assets: AssetStore, private readonly batches: BatchService, private readonly shopify: PublishingShopify) {
    this.folder = path.join(dataDir, 'publications');
  }

  async init() {
    await mkdir(this.folder, { recursive: true });
    for (const operationId of await readdir(this.folder)) {
      if (!STRICT_UUID.test(operationId)) continue;
      const operation = await this.readLatest(operationId).catch(() => undefined);
      if (!operation) continue;
      if (operation.status === 'publishing') { operation.status = 'partial'; operation.errors.push('Publishing was interrupted; retry after reviewing current Shopify state.'); await this.checkpoint(operation); }
      if (operation.status === 'rolling_back') { operation.status = 'rollback_partial'; operation.errors.push('Rollback was interrupted; retry after reviewing current Shopify state.'); await this.checkpoint(operation); }
      this.records.set(operation.id, operation);
    }
  }

  list() { return [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); }
  get(id: string) { this.assertId(id); const operation = this.records.get(id); if (!operation) throw new PublicationError('Publication operation not found.', 404); return operation; }

  async validate(batchId: string): Promise<PublishReadiness> {
    const { batch, errors, colors } = await this.preflight(batchId);
    return { ready: errors.length === 0, batchId, productId: batch.productId, imageCount: colors.length, variantCount: colors.reduce((sum, item) => sum + item.variantIds.length, 0), colors: colors.map(({ color, variantIds, previewId }) => ({ color, variantCount: variantIds.length, previewId })), errors };
  }

  async publish(batchId: string) {
    const existing = this.list().find((operation) => operation.batchId === batchId && operation.status !== 'rolled_back');
    if (existing && !['partial'].includes(existing.status)) throw new PublicationError('This batch already has a publication operation.', 409);
    const context = await this.preflight(batchId);
    if (context.errors.length) throw new PublicationError(context.errors.join(' '), 409);
    let operation = existing;
    if (!operation) {
      const now = new Date().toISOString();
      operation = {
        id: crypto.randomUUID(), version: 1, batchId, productId: context.batch.productId, productTitle: context.batch.productTitle,
        createdAt: now, updatedAt: now, status: 'validated', originalMediaOrder: context.state.mediaIds,
        originalVariantMedia: context.state.variants.map((variant) => ({ variantId: variant.id, mediaIds: variant.mediaIds })),
        items: context.colors.map((item) => ({ color: item.color, previewId: item.previewId, variantIds: item.variantIds, status: 'pending' })),
        completedSteps: [], errors: []
      };
      this.records.set(operation.id, operation); await this.checkpoint(operation);
    }
    return this.withLock(operation.productId, async () => {
      operation!.status = 'publishing'; operation!.errors = []; await this.checkpoint(operation!);
      for (const item of operation!.items) {
        if (item.status === 'associated') continue;
        try {
          const bytes = (await this.assets.bytes('preview', item.previewId)).buffer;
          const filename = `${operation!.productTitle}-${item.color}.png`.replace(/[^a-z0-9._-]+/gi, '-');
          if (!item.createdMediaId) {
            const resourceUrl = await this.shopify.stageImage(filename, bytes);
            const file = await this.shopify.createImageFile(resourceUrl, `${operation!.productTitle} - ${item.color}`);
            item.createdMediaId = file.id; item.status = 'uploaded'; operation!.completedSteps.push(`created:${item.color}`); await this.checkpoint(operation!);
          }
          if (!operation!.completedSteps.includes(`product:${item.color}`)) {
            // A partial retry may resume after fileCreate but before Shopify finished
            // processing the MediaImage, so readiness must be checked on every resume.
            const mediaId = item.createdMediaId;
            if (!mediaId) throw new PublicationError('Created Shopify media ID is missing.', 500);
            await this.shopify.waitForFileReady(mediaId);
            await this.shopify.addFileToProduct(mediaId, operation!.productId);
            operation!.completedSteps.push(`product:${item.color}`); await this.checkpoint(operation!);
          }
          if (!operation!.completedSteps.includes(`variants:${item.color}`)) {
            await this.shopify.appendVariantMedia(operation!.productId, item.createdMediaId, item.variantIds);
            operation!.completedSteps.push(`variants:${item.color}`); await this.checkpoint(operation!);
          }
          item.status = 'associated'; item.error = undefined; await this.checkpoint(operation!);
        } catch (error) {
          item.status = 'failed'; item.error = error instanceof Error ? error.message : 'Publication failed.';
          operation!.errors.push(`${item.color}: ${item.error}`); await this.checkpoint(operation!);
        }
      }
      operation!.status = operation!.items.every((item) => item.status === 'associated') ? 'published' : 'partial';
      await this.checkpoint(operation!); return operation!;
    });
  }

  async rollback(operationId: string) {
    const operation = this.get(operationId);
    if (!['published', 'partial', 'rollback_partial', 'conflict'].includes(operation.status)) throw new PublicationError('This operation is not eligible for rollback.', 409);
    return this.withLock(operation.productId, async () => {
      const current = await this.shopify.getPublicationState(operation.productId);
      const original = new Set(operation.originalMediaOrder);
      const created = new Set(operation.items.map((item) => item.createdMediaId).filter((id): id is string => Boolean(id)));
      const unexpected = current.mediaIds.filter((id) => !original.has(id) && !created.has(id));
      const missingOriginals = operation.originalMediaOrder.filter((id) => !current.mediaIds.includes(id));
      if (unexpected.length || missingOriginals.length) {
        operation.status = 'conflict'; operation.errors = ['Shopify media changed outside this publication. Manual review is required before rollback.']; await this.checkpoint(operation); return operation;
      }
      operation.status = 'rolling_back'; operation.errors = []; await this.checkpoint(operation);
      for (const item of operation.items) {
        if (!item.createdMediaId || item.status === 'rolled_back') continue;
        try {
          if (!operation.completedSteps.includes(`detached:${item.color}`)) {
            await this.shopify.detachVariantMedia(operation.productId, item.createdMediaId, item.variantIds);
            operation.completedSteps.push(`detached:${item.color}`); await this.checkpoint(operation);
          }
          for (const variantId of item.variantIds) {
            const snapshot = operation.originalVariantMedia.find((entry) => entry.variantId === variantId);
            const live = current.variants.find((entry) => entry.id === variantId);
            for (const mediaId of snapshot?.mediaIds ?? []) if (!live?.mediaIds.includes(mediaId)) await this.shopify.appendVariantMedia(operation.productId, mediaId, [variantId]);
          }
          if (!operation.completedSteps.includes(`removed:${item.color}`)) {
            await this.shopify.removeFileFromProduct(item.createdMediaId, operation.productId);
            await this.shopify.deleteFile(item.createdMediaId);
            operation.completedSteps.push(`removed:${item.color}`); await this.checkpoint(operation);
          }
          item.status = 'rolled_back'; item.error = undefined; await this.checkpoint(operation);
        } catch (error) {
          item.error = error instanceof Error ? error.message : 'Rollback failed.'; operation.errors.push(`${item.color}: ${item.error}`); await this.checkpoint(operation);
        }
      }
      try { await this.shopify.reorderMedia(operation.productId, operation.originalMediaOrder); operation.completedSteps.push('original-order-restored'); }
      catch (error) { operation.errors.push(error instanceof Error ? error.message : 'Original media order could not be restored.'); }
      operation.status = operation.items.every((item) => item.status === 'rolled_back') && operation.errors.length === 0 ? 'rolled_back' : 'rollback_partial';
      await this.checkpoint(operation); return operation;
    });
  }

  private async preflight(batchId: string) {
    const errors: string[] = [];
    let batch: MockupBatch;
    try { batch = await this.batches.get(batchId); } catch { throw new PublicationError('Batch not found.', 404); }
    if (batch.status !== 'completed') errors.push('The selected batch must be fully completed with no failed or skipped colors.');
    const [product, state] = await Promise.all([this.shopify.getProduct(batch.productId, false), this.shopify.getPublicationState(batch.productId)]);
    const colors: Array<{ color: string; variantIds: string[]; previewId: string }> = [];
    for (const item of batch.items) {
      if (item.status !== 'success' || !item.preview || !item.sourceImageId) { errors.push(`${item.color}: generated preview or reliable source mapping is missing.`); continue; }
      const sourceImageId = item.sourceImageId;
      const variants = product.variants.filter((variant) => variant.color === item.color);
      const source = product.images.find((image) => image.id === sourceImageId && image.association === 'reliable' && image.associatedColors.length === 1 && image.associatedColors[0] === item.color);
      if (!source || variants.length === 0 || variants.some((variant) => !variant.associatedImageIds.includes(sourceImageId))) { errors.push(`${item.color}: current Shopify variant mapping conflicts with the batch source.`); continue; }
      try { const bytes = (await this.assets.bytes('preview', item.preview.id)).buffer; await inspectImage(bytes, ['png']); }
      catch { errors.push(`${item.color}: generated preview file is missing or invalid.`); continue; }
      colors.push({ color: item.color, variantIds: variants.map((variant) => variant.id), previewId: item.preview.id });
    }
    return { batch, product, state, errors, colors };
  }

  private async checkpoint(operation: PublicationOperation) {
    operation.updatedAt = new Date().toISOString();
    const directory = path.join(this.folder, operation.id); await mkdir(directory, { recursive: true });
    const sequence = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).length;
    await writeFile(path.join(directory, `${String(sequence).padStart(6, '0')}.json`), JSON.stringify(operation, null, 2), { flag: 'wx' });
    this.records.set(operation.id, operation);
  }

  private async readLatest(id: string) {
    const directory = path.join(this.folder, id);
    const files = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
    if (!files.length) throw new PublicationError('Publication operation not found.', 404);
    return JSON.parse(await readFile(path.join(directory, files.at(-1)!), 'utf8')) as PublicationOperation;
  }

  private async withLock<T>(productId: string, action: () => Promise<T>) {
    if (this.locks.has(productId)) throw new PublicationError('Another publication or rollback is already running for this product.', 409);
    this.locks.add(productId); try { return await action(); } finally { this.locks.delete(productId); }
  }
  private assertId(id: string) { if (!STRICT_UUID.test(id)) throw new PublicationError('Publication operation not found.', 404); }
}
