import crypto from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MockupBatch, PublicationItem, PublicationOperation, PublishReadiness } from '@mockup-automation/shared';
import { inspectImage } from './images.js';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import type { ShopifyPublicationState, ShopifyService } from './shopify.js';

const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP = (kind: string, color: string) => `${kind}:${color}`;
type PublishingShopify = Pick<ShopifyService, 'getProduct' | 'getPublicationState' | 'stageImage' | 'createImageFile' | 'waitForFileReady' | 'addFileToProduct' | 'removeFileFromProduct' | 'appendVariantMedia' | 'detachVariantMedia' | 'reorderMedia' | 'deleteFile' | 'verifyFileDeletionSafe'>;

export class PublicationError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const same = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
function validOperation(value: unknown): value is PublicationOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PublicationOperation>;
  return item.version === 1 && typeof item.id === 'string' && STRICT_UUID.test(item.id) && typeof item.batchId === 'string' &&
    typeof item.productId === 'string' && typeof item.status === 'string' && Array.isArray(item.originalMediaOrder) &&
    Array.isArray(item.originalVariantMedia) && Array.isArray(item.expectedPublishedMediaOrder) && Array.isArray(item.items) &&
    item.items.every((entry) => entry && typeof entry.color === 'string' && typeof entry.previewId === 'string' && Array.isArray(entry.variantIds)) &&
    Array.isArray(item.completedSteps) && Array.isArray(item.errors);
}

export class PublishingService {
  private readonly folder: string;
  private readonly records = new Map<string, PublicationOperation>();
  private readonly locks = new Set<string>();
  constructor(dataDir: string, private readonly assets: AssetStore, private readonly batches: BatchService, private readonly shopify: PublishingShopify) { this.folder = path.join(dataDir, 'publications'); }

  async init() {
    await mkdir(this.folder, { recursive: true });
    for (const operationId of await readdir(this.folder)) {
      if (!STRICT_UUID.test(operationId)) continue;
      const operation = await this.readLatest(operationId).catch(() => undefined);
      if (!operation) continue;
      const uncertainItems = operation.items.filter((item) => item.intent === 'create_file' && !item.createdMediaId);
      if (uncertainItems.length) {
        for (const item of uncertainItems) { item.uncertainCreation = true; item.status = 'failed'; item.error = 'Shopify file creation may have completed before the process stopped; ownership is uncertain.'; }
        operation.status = 'conflict'; operation.errors = uncertainItems.map((item) => `${item.color}: interrupted fileCreate requires manual reconciliation; it will not be retried.`);
        await this.checkpoint(operation);
      } else if (operation.status === 'publishing') { operation.status = 'partial'; operation.errors.push('Publishing was interrupted; live reconciliation is required before retry.'); await this.checkpoint(operation); }
      if (operation.status === 'rolling_back') { operation.status = 'rollback_partial'; operation.errors.push('Rollback was interrupted; live reconciliation is required before retry.'); await this.checkpoint(operation); }
      this.records.set(operation.id, operation);
    }
  }
  list() { return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string) { this.assertId(id); const operation = this.records.get(id); if (!operation) throw new PublicationError('Publication operation not found.', 404); return operation; }
  async validate(batchId: string): Promise<PublishReadiness> {
    const { batch, errors, colors } = await this.preflight(batchId);
    return { ready: !errors.length, batchId, productId: batch.productId, imageCount: colors.length, variantCount: colors.reduce((sum, item) => sum + item.variantIds.length, 0), colors: colors.map(({ color, variantIds, previewId }) => ({ color, variantCount: variantIds.length, previewId })), errors };
  }

  async publish(batchId: string) {
    const existing = this.list().find((op) => op.batchId === batchId && op.status !== 'rolled_back');
    if (existing && existing.status !== 'partial') throw new PublicationError('This batch already has a publication operation.', 409);
    let operation = existing;
    if (!operation) {
      const context = await this.preflight(batchId);
      if (context.errors.length) throw new PublicationError(context.errors.join(' '), 409);
      const now = new Date().toISOString();
      operation = { id: crypto.randomUUID(), version: 1, batchId, productId: context.batch.productId, productTitle: context.batch.productTitle,
        createdAt: now, updatedAt: now, status: 'validated', originalMediaOrder: [...context.state.mediaIds],
        originalVariantMedia: context.state.variants.map((v) => ({ variantId: v.id, mediaIds: [...v.mediaIds] })), expectedPublishedMediaOrder: [...context.state.mediaIds],
        items: context.colors.map((item) => ({ color: item.color, previewId: item.previewId, variantIds: item.variantIds, status: 'pending' })), completedSteps: [], errors: [] };
      this.records.set(operation.id, operation); await this.checkpoint(operation);
    }
    return this.withLock(operation.productId, async () => {
      if (existing) { const conflict = await this.reconcilePublication(operation!); if (conflict) return this.markConflict(operation!, conflict); }
      operation!.status = 'publishing'; operation!.errors = []; await this.checkpoint(operation!);
      for (const item of operation!.items) {
        if (item.status === 'associated') continue;
        if (item.uncertainCreation || (item.intent === 'create_file' && !item.createdMediaId)) return this.markConflict(operation!, `${item.color}: file creation result is uncertain and cannot be safely retried.`);
        try {
          const bytes = (await this.assets.bytes('preview', item.previewId)).buffer;
          const filename = `${operation!.productTitle}-${item.color}.png`.replace(/[^a-z0-9._-]+/gi, '-');
          if (!item.stagedResourceUrl) { await this.intent(operation!, item, 'stage_upload'); item.stagedResourceUrl = await this.shopify.stageImage(filename, bytes); item.intent = undefined; await this.checkpoint(operation!); }
          if (!item.createdMediaId) {
            await this.intent(operation!, item, 'create_file');
            try {
              const file = await this.shopify.createImageFile(item.stagedResourceUrl, `${operation!.productTitle} - ${item.color} [${operation!.id}]`);
              item.createdMediaId = file.id; item.status = 'uploaded'; item.intent = undefined; operation!.completedSteps.push(STEP('created', item.color)); operation!.expectedPublishedMediaOrder.push(file.id); await this.checkpoint(operation!);
            } catch (error) {
              item.uncertainCreation = true; item.error = error instanceof Error ? error.message : 'File creation result is uncertain.'; await this.checkpoint(operation!);
              return this.markConflict(operation!, `${item.color}: Shopify file creation returned no durable ownership proof; manual reconciliation is required.`);
            }
          }
          const mediaId = item.createdMediaId; if (!mediaId) throw new PublicationError('Created Shopify media ID is missing.', 500);
          if (!operation!.completedSteps.includes(STEP('product', item.color))) {
            await this.shopify.waitForFileReady(mediaId); await this.intent(operation!, item, 'add_product_reference'); await this.shopify.addFileToProduct(mediaId, operation!.productId);
            item.intent = undefined; operation!.completedSteps.push(STEP('product', item.color)); await this.checkpoint(operation!);
          }
          if (!operation!.completedSteps.includes(STEP('variants', item.color))) {
            await this.intent(operation!, item, 'append_variants'); await this.shopify.appendVariantMedia(operation!.productId, mediaId, item.variantIds);
            item.intent = undefined; operation!.completedSteps.push(STEP('variants', item.color)); await this.checkpoint(operation!);
          }
          item.status = 'associated'; item.error = undefined; await this.checkpoint(operation!);
        } catch (error) { item.status = 'failed'; item.error = error instanceof Error ? error.message : 'Publication failed.'; operation!.errors.push(`${item.color}: ${item.error}`); await this.checkpoint(operation!); }
      }
      if (operation!.items.every((item) => item.status === 'associated')) {
        const marker = operation!.items[0];
        try {
          if (marker) await this.intent(operation!, marker, 'reorder_published');
          await this.shopify.reorderMedia(operation!.productId, operation!.expectedPublishedMediaOrder); if (marker) marker.intent = undefined;
          operation!.completedSteps.push('published-order'); await this.checkpoint(operation!);
        } catch (error) {
          operation!.status = 'partial'; operation!.errors.push(error instanceof Error ? error.message : 'Published ordering failed.'); await this.checkpoint(operation!); return operation!;
        }
        const conflict = this.compareExpected(operation!, await this.shopify.getPublicationState(operation!.productId), 'published');
        if (conflict) return this.markConflict(operation!, `Published state verification failed: ${conflict}`);
        operation!.status = 'published';
      } else operation!.status = 'partial';
      await this.checkpoint(operation!); return operation!;
    });
  }

  async rollback(operationId: string) {
    const operation = this.get(operationId);
    if (!['published', 'partial', 'rollback_partial', 'conflict'].includes(operation.status)) throw new PublicationError('This operation is not eligible for rollback.', 409);
    return this.withLock(operation.productId, async () => {
      const current = await this.shopify.getPublicationState(operation.productId);
      const conflict = this.compareExpected(operation, current, 'rollback'); if (conflict) return this.markConflict(operation, `Rollback blocked: ${conflict}`);
      operation.status = 'rolling_back'; operation.errors = []; operation.cleanupConflicts = []; operation.productRestored = false; await this.checkpoint(operation);
      for (const item of [...operation.items].reverse()) {
        if (!item.createdMediaId || (item.status === 'rolled_back' && !item.cleanupPending)) continue;
        try {
          const mediaId = item.createdMediaId; const liveVariantIds = current.variants.filter((v) => v.mediaIds.includes(mediaId)).map((v) => v.id);
          if (liveVariantIds.length) { await this.intent(operation, item, 'detach_variants'); await this.shopify.detachVariantMedia(operation.productId, mediaId, liveVariantIds); item.intent = undefined; operation.completedSteps.push(STEP('detached', item.color)); await this.checkpoint(operation); }
          if (current.mediaIds.includes(mediaId)) { await this.intent(operation, item, 'remove_product_reference'); await this.shopify.removeFileFromProduct(mediaId, operation.productId); item.intent = undefined; operation.completedSteps.push(STEP('removed-reference', item.color)); await this.checkpoint(operation); }
          const deletion = await this.shopify.verifyFileDeletionSafe(mediaId, operation.productId);
          if (!deletion.safe) {
            item.status = 'rolled_back'; item.cleanupPending = true;
            const cleanupMessage = `${item.color}: generated file was preserved because deletion ownership is uncertain: ${deletion.reason}`;
            operation.cleanupConflicts.push(cleanupMessage); await this.checkpoint(operation); continue;
          }
          await this.intent(operation, item, 'delete_file'); await this.shopify.deleteFile(mediaId); item.intent = undefined; operation.completedSteps.push(STEP('deleted', item.color)); item.status = 'rolled_back'; item.cleanupPending = false; item.error = undefined; await this.checkpoint(operation);
        } catch (error) { item.error = error instanceof Error ? error.message : 'Rollback failed.'; operation.errors.push(`${item.color}: ${item.error}`); await this.checkpoint(operation); }
      }
      if (operation.items.every((item) => !item.createdMediaId || item.status === 'rolled_back')) {
        const marker = operation.items[0]; if (marker) await this.intent(operation, marker, 'restore_order'); await this.shopify.reorderMedia(operation.productId, operation.originalMediaOrder); if (marker) marker.intent = undefined;
        operation.completedSteps.push('original-order-restored'); await this.checkpoint(operation);
        const live = await this.shopify.getPublicationState(operation.productId); const expectedVariants = new Map(operation.originalVariantMedia.map((v) => [v.variantId, v.mediaIds]));
        const restored = same(live.mediaIds, operation.originalMediaOrder) && live.variants.every((v) => same(v.mediaIds, expectedVariants.get(v.id) ?? []));
        operation.productRestored = restored;
        if (!restored) { operation.status = 'conflict'; operation.errors.push('Product restoration did not match the immutable original snapshot.'); }
        else if (operation.cleanupConflicts.length) { operation.status = 'conflict'; operation.errors.push('Product restoration succeeded, but generated-file cleanup requires manual review.'); }
        else operation.status = 'rolled_back';
      } else operation.status = 'rollback_partial';
      await this.checkpoint(operation); return operation;
    });
  }

  private async reconcilePublication(operation: PublicationOperation) {
    if (operation.items.some((item) => item.uncertainCreation || (item.intent === 'create_file' && !item.createdMediaId))) return 'A fileCreate result is uncertain; manual ownership reconciliation is required and fileCreate will not be retried.';
    const live = await this.shopify.getPublicationState(operation.productId); const conflict = this.compareExpected(operation, live, 'publish-retry'); if (conflict) return conflict;
    for (const item of operation.items) {
      if (!item.createdMediaId) continue; const onProduct = live.mediaIds.includes(item.createdMediaId);
      const associated = item.variantIds.every((id) => live.variants.find((v) => v.id === id)?.mediaIds.includes(item.createdMediaId!));
      if (onProduct && !operation.completedSteps.includes(STEP('product', item.color))) operation.completedSteps.push(STEP('product', item.color));
      if (associated && !operation.completedSteps.includes(STEP('variants', item.color))) operation.completedSteps.push(STEP('variants', item.color));
      if (associated) item.status = 'associated';
    }
    await this.checkpoint(operation); return undefined;
  }

  private compareExpected(operation: PublicationOperation, live: ShopifyPublicationState, mode: 'publish-retry' | 'published' | 'rollback') {
    if (!live.complete) return 'Shopify returned an incomplete publication snapshot.';
    const created = operation.items.map((item) => item.createdMediaId).filter((id): id is string => Boolean(id)); const allowed = new Set([...operation.originalMediaOrder, ...created]);
    if (live.mediaIds.some((id) => !allowed.has(id))) return 'unrelated product media changed externally.';
    if (operation.originalMediaOrder.some((id) => !live.mediaIds.includes(id))) return 'original product media is missing.';
    if (mode !== 'rollback') for (const item of operation.items) {
      if (item.createdMediaId && operation.completedSteps.includes(STEP('product', item.color)) && !live.mediaIds.includes(item.createdMediaId)) return `${item.color} product media reference changed externally.`;
    }
    if (!same(live.mediaIds.filter((id) => operation.originalMediaOrder.includes(id)), operation.originalMediaOrder)) return 'original product media ordering changed externally.';
    if (mode === 'published' && !same(live.mediaIds, operation.expectedPublishedMediaOrder)) return 'published media ordering does not match the recorded order.';
    const originals = new Map(operation.originalVariantMedia.map((entry) => [entry.variantId, entry.mediaIds]));
    for (const variant of live.variants) {
      const expected = [...(originals.get(variant.id) ?? [])];
      for (const item of operation.items) {
        if (!item.variantIds.includes(variant.id) || !item.createdMediaId) continue;
        const expectCreated = mode === 'published' || (mode === 'publish-retry' && (operation.completedSteps.includes(STEP('variants', item.color)) || (item.intent === 'append_variants' && variant.mediaIds.includes(item.createdMediaId)))) ||
          (mode === 'rollback' && variant.mediaIds.includes(item.createdMediaId));
        if (expectCreated) expected.push(item.createdMediaId);
      }
      if (!same(variant.mediaIds, expected)) return `variant ${variant.id} media changed externally.`;
    }
    if (live.variants.length !== operation.originalVariantMedia.length) return 'the product variant set changed externally.';
    return undefined;
  }

  private async preflight(batchId: string) {
    const errors: string[] = []; let batch: MockupBatch; try { batch = await this.batches.get(batchId); } catch { throw new PublicationError('Batch not found.', 404); }
    if (batch.status !== 'completed') errors.push('The selected batch must be fully completed with no failed or skipped colors.');
    const [product, state] = await Promise.all([this.shopify.getProduct(batch.productId, false), this.shopify.getPublicationState(batch.productId)]); if (!state.complete) errors.push('Shopify publication snapshot is incomplete.');
    const colors: Array<{ color: string; variantIds: string[]; previewId: string }> = [];
    for (const item of batch.items) {
      if (item.status !== 'success' || !item.preview || !item.sourceImageId) { errors.push(`${item.color}: generated preview or reliable source mapping is missing.`); continue; }
      const sourceImageId = item.sourceImageId; const variants = product.variants.filter((variant) => variant.color === item.color);
      const source = product.images.find((img) => img.id === sourceImageId && img.association === 'reliable' && img.associatedColors.length === 1 && img.associatedColors[0] === item.color);
      if (!source || !variants.length || variants.some((variant) => !variant.associatedImageIds.includes(sourceImageId))) { errors.push(`${item.color}: current Shopify variant mapping conflicts with the batch source.`); continue; }
      try { await inspectImage((await this.assets.bytes('preview', item.preview.id)).buffer, ['png']); } catch { errors.push(`${item.color}: generated preview file is missing or invalid.`); continue; }
      colors.push({ color: item.color, variantIds: variants.map((v) => v.id), previewId: item.preview.id });
    }
    return { batch, state, errors, colors };
  }

  private async intent(operation: PublicationOperation, item: PublicationItem, intent: NonNullable<PublicationItem['intent']>) { item.intent = intent; await this.checkpoint(operation); }
  private async markConflict(operation: PublicationOperation, message: string) { operation.status = 'conflict'; operation.errors = [message]; await this.checkpoint(operation); return operation; }
  private async checkpoint(operation: PublicationOperation) {
    operation.updatedAt = new Date().toISOString(); const directory = path.join(this.folder, operation.id); await mkdir(directory, { recursive: true });
    const files = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)); const sequence = files.length ? Math.max(...files.map((name) => Number(name.slice(0, 6)))) + 1 : 0;
    const finalPath = path.join(directory, `${String(sequence).padStart(6, '0')}.json`); const tempPath = `${finalPath}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(tempPath, JSON.stringify(operation, null, 2), { flag: 'wx' }); await rename(tempPath, finalPath); } catch (error) { await unlink(tempPath).catch(() => undefined); throw error; }
    this.records.set(operation.id, structuredClone(operation));
  }
  private async readLatest(id: string) {
    const directory = path.join(this.folder, id); const files = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).sort().reverse();
    for (const file of files) { try {
      const parsed: unknown = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      const legacy = parsed as Partial<PublicationOperation>;
      if (legacy?.version === 1 && !Array.isArray(legacy.expectedPublishedMediaOrder) && Array.isArray(legacy.originalMediaOrder) && Array.isArray(legacy.items)) {
        legacy.expectedPublishedMediaOrder = [...legacy.originalMediaOrder, ...legacy.items.map((item) => item.createdMediaId).filter((mediaId): mediaId is string => Boolean(mediaId))];
      }
      if (validOperation(parsed) && parsed.id === id) return parsed;
    } catch { /* fall back to the previous complete checkpoint */ } }
    throw new PublicationError('No complete publication checkpoint was found.', 409);
  }
  private async withLock<T>(productId: string, action: () => Promise<T>) { if (this.locks.has(productId)) throw new PublicationError('Another publication or rollback is already running for this product.', 409); this.locks.add(productId); try { return await action(); } finally { this.locks.delete(productId); } }
  private assertId(id: string) { if (!STRICT_UUID.test(id)) throw new PublicationError('Publication operation not found.', 404); }
}
