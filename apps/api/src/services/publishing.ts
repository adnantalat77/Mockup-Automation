import crypto from 'node:crypto';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AbandonReadiness, AbandonmentEvidence, MockupBatch, PublicationItem, PublicationOperation, PublishReadiness, RecoveryReadiness, RollbackFinalizationEvidence, RollbackFinalizationReadiness, RollbackMode } from '@mockup-automation/shared';
import { analyzeTransparency, inspectImage } from './images.js';
import { AssetStore } from './storage.js';
import { BatchService } from './batches.js';
import type { ShopifyPublicationState, ShopifyService } from './shopify.js';
import { atomicWriteFile, type AtomicWriter } from './persistence.js';

const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const STEP = (kind: string, color: string) => `${kind}:${color}`;
export const ABANDONMENT_TEST_PRODUCT_ID = 'gid://shopify/Product/15608846975264';
const ABANDONMENT_TEST_PRODUCT_TITLE = 'Mockup Automation - TEST ONLY';
const NONBLOCKING_STATUSES = new Set(['published', 'rolled_back', 'rolled_back_files_retained', 'abandoned']);
const OPERATION_STATUSES = new Set(['validated', 'publishing', 'published', 'partial', 'rolling_back', 'rolled_back', 'rolled_back_files_retained', 'rollback_partial', 'conflict', 'abandoned']);
const ITEM_STATUSES = new Set(['pending', 'uploaded', 'associated', 'failed', 'rolled_back']);
const ITEM_INTENTS = new Set(['stage_upload', 'create_file', 'add_product_reference', 'append_variants', 'replace_variants', 'remove_original_reference', 'restore_original_reference', 'restore_variants', 'reorder_published', 'detach_variants', 'remove_product_reference', 'delete_file', 'restore_order']);
type PublishingShopify = Pick<ShopifyService, 'getProduct' | 'getPublicationState' | 'downloadImage' | 'stageImage' | 'createImageFile' | 'waitForFileReady' | 'addFileToProduct' | 'removeFileFromProduct' | 'replaceVariantMedia' | 'detachVariantMedia' | 'reorderMedia'>;

export class PublicationError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export class PublicationPersistenceError extends Error { constructor(message: string, readonly cause?: unknown) { super(message); this.name = 'PublicationPersistenceError'; } }
const same = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
function structurallyValidOperation(value: unknown): value is PublicationOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PublicationOperation>;
  return item.version === 1 && typeof item.id === 'string' && STRICT_UUID.test(item.id) && typeof item.batchId === 'string' &&
    typeof item.productId === 'string' && typeof item.productTitle === 'string' && typeof item.status === 'string' && Array.isArray(item.originalMediaOrder) && item.originalMediaOrder.every((id) => typeof id === 'string') &&
    Array.isArray(item.originalVariantMedia) && item.originalVariantMedia.every((entry) => entry && typeof entry.variantId === 'string' && Array.isArray(entry.mediaIds) && entry.mediaIds.every((id) => typeof id === 'string')) &&
    Array.isArray(item.expectedPublishedMediaOrder) && item.expectedPublishedMediaOrder.every((id) => typeof id === 'string') && Array.isArray(item.items) &&
    item.items.every((entry) => entry && typeof entry.color === 'string' && typeof entry.previewId === 'string' && Array.isArray(entry.variantIds) && entry.variantIds.every((id) => typeof id === 'string')) &&
    Array.isArray(item.completedSteps) && item.completedSteps.every((step) => typeof step === 'string') && Array.isArray(item.errors) && item.errors.every((error) => typeof error === 'string');
}

function duplicates(values: string[]) { return values.length !== new Set(values).size; }
function operationIntegrityErrors(operation: PublicationOperation) {
  const errors: string[] = [];
  if (!OPERATION_STATUSES.has(operation.status)) errors.push('invalid operation status');
  if (!PRODUCT_GID.test(operation.productId) || typeof operation.productTitle !== 'string' || !operation.productTitle) errors.push('invalid product identity');
  if (duplicates(operation.originalMediaOrder)) errors.push('duplicate original media IDs');
  if (duplicates(operation.expectedPublishedMediaOrder)) errors.push('duplicate expected media IDs');
  if (duplicates(operation.completedSteps)) errors.push('duplicate completed steps');
  const originalVariantIds = operation.originalVariantMedia.map((entry) => entry.variantId);
  if (duplicates(originalVariantIds) || operation.originalVariantMedia.some((entry) => duplicates(entry.mediaIds))) errors.push('duplicate immutable variant evidence');
  const colors = operation.items.map((entry) => entry.color);
  const mappedVariants = operation.items.flatMap((entry) => entry.variantIds);
  const createdMedia = operation.items.map((entry) => entry.createdMediaId).filter((id): id is string => Boolean(id));
  if (duplicates(colors) || duplicates(mappedVariants) || duplicates(createdMedia)) errors.push('duplicate item ownership evidence');
  if (operation.items.some((entry) => !entry.color || !STRICT_UUID.test(entry.previewId) || !ITEM_STATUSES.has(entry.status) || duplicates(entry.variantIds) || entry.variantIds.some((id) => !originalVariantIds.includes(id)))) errors.push('invalid publication item evidence');
  if (operation.items.some((entry) => entry.intent && !ITEM_INTENTS.has(entry.intent))) errors.push('invalid pending mutation intent');
  if (operation.items.some((entry) => entry.intent && entry.intent !== 'stage_upload' && entry.intent !== 'create_file' && !entry.createdMediaId)) errors.push('mutation intent lacks created-media ownership');
  if (operation.rollbackMode && operation.rollbackMode !== 'no_global_delete') errors.push('invalid rollback mode');
  if (operation.sourceValidationSchemaVersion === 1 && operation.items.some((entry) => !entry.sourceProvenance || !entry.generationEvidence)) errors.push('incomplete source-integrity evidence');
  if (mappedVariants.length !== originalVariantIds.length || originalVariantIds.some((id) => !mappedVariants.includes(id))) errors.push('incomplete item-to-variant ownership');
  const originalMedia = new Set(operation.originalMediaOrder);
  if (operation.originalVariantMedia.some((entry) => entry.mediaIds.some((id) => !originalMedia.has(id)))) errors.push('variant association outside original gallery');
  return errors;
}

function snapshotStructureError(state: ShopifyPublicationState) {
  if (state.complete !== true) return 'Shopify returned an incomplete publication snapshot.';
  if (duplicates(state.mediaIds)) return 'Shopify product media snapshot contains duplicate IDs.';
  if (duplicates(state.variants.map((variant) => variant.id))) return 'Shopify variant snapshot contains duplicate IDs.';
  if (state.variants.some((variant) => duplicates(variant.mediaIds))) return 'Shopify variant-media snapshot contains duplicate associations.';
  return undefined;
}

function exactVariantError(expected: Array<{ variantId: string; mediaIds: string[] }>, live: ShopifyPublicationState['variants']) {
  if (expected.length !== live.length) return 'the product variant set changed externally.';
  const expectedById = new Map(expected.map((entry) => [entry.variantId, entry.mediaIds]));
  for (const variant of live) {
    const association = expectedById.get(variant.id);
    if (!association) return `unexpected variant ${variant.id}.`;
    if (!same(variant.mediaIds, association)) return `variant ${variant.id} media changed externally.`;
  }
  for (const entry of expected) if (!live.some((variant) => variant.id === entry.variantId)) return `expected variant ${entry.variantId} is missing.`;
  return undefined;
}

function terminalPublicationError(operation: PublicationOperation) {
  if (operation.items.some((item) => item.intent)) return 'a mutation intent remains unresolved.';
  if (operation.items.some((item) => !item.createdMediaId || item.status !== 'associated' || !operation.completedSteps.includes(STEP('created', item.color)) || !operation.completedSteps.includes(STEP('product', item.color)) || !operation.completedSteps.includes(STEP('variants', item.color)))) return 'required publication steps are incomplete.';
  const created = operation.items.map((item) => item.createdMediaId!);
  const expected = operation.publicationMode === 'replace_gallery' ? created : [...operation.originalMediaOrder, ...created];
  if (!same(expected, operation.expectedPublishedMediaOrder)) return 'generated media ownership does not match the expected published order.';
  if (!operation.completedSteps.includes('published-order')) return 'published media ordering was not durably checkpointed.';
  if (operation.publicationMode === 'replace_gallery' && operation.originalMediaOrder.some((id) => !operation.completedSteps.includes(`removed-original:${id}`))) return 'original media removal is not durably complete.';
  return undefined;
}

export function validatePublicationCheckpointData(parsed: unknown, directoryId: string, filename = 'checkpoint') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PublicationError(`Publication checkpoint integrity validation failed for ${filename}: expected an operation object.`, 409);
  const candidate = structuredClone(parsed) as Partial<PublicationOperation>;
  if (candidate.version === 1 && !Array.isArray(candidate.expectedPublishedMediaOrder) && Array.isArray(candidate.originalMediaOrder) && Array.isArray(candidate.items) && candidate.items.every((item) => item && typeof item === 'object')) {
    candidate.expectedPublishedMediaOrder = [...candidate.originalMediaOrder, ...candidate.items.map((item) => item.createdMediaId).filter((mediaId): mediaId is string => Boolean(mediaId))];
  }
  if (!structurallyValidOperation(candidate)) throw new PublicationError(`Publication checkpoint integrity validation failed for ${filename}: required fields or field types are invalid.`, 409);
  const integrityErrors = operationIntegrityErrors(candidate);
  if (integrityErrors.length) throw new PublicationError(`Publication checkpoint integrity validation failed for ${filename}: ${integrityErrors.join(', ')}.`, 409);
  if (candidate.id !== directoryId) throw new PublicationError(`Publication checkpoint integrity validation failed for ${filename}: operation ID does not match its directory.`, 409);
  return candidate;
}

export class PublishingService {
  private readonly folder: string;
  private readonly records = new Map<string, PublicationOperation>();
  private readonly locks = new Set<string>();
  private readonly persistenceBlockedProducts = new Set<string>();
  private readonly restorationMarker: string;
  private readonly allowedProductIds: Set<string>;
  constructor(dataDir: string, private readonly assets: AssetStore, private readonly batches: BatchService, private readonly shopify: PublishingShopify, allowedProductIds: string[] = [], private readonly checkpointWriter: AtomicWriter = atomicWriteFile) {
    this.folder = path.join(dataDir, 'publications');
    this.restorationMarker = path.join(dataDir, 'RESTORED_FROM_BACKUP.json');
    if (allowedProductIds.some((id) => !PRODUCT_GID.test(id))) throw new PublicationError('SHOPIFY_PUBLISH_PRODUCT_IDS contains an invalid Shopify Product GID.', 500);
    this.allowedProductIds = new Set(allowedProductIds);
  }

  async init() {
    await mkdir(this.folder, { recursive: true });
    for (const operationId of await readdir(this.folder)) {
      if (!STRICT_UUID.test(operationId)) continue;
      const operation = await this.readLatest(operationId);
      const uncertainItems = operation.items.filter((item) => item.intent === 'create_file' && !item.createdMediaId);
      const uncertainDeletionItems = operation.items.filter((item) => item.intent === 'delete_file' && item.createdMediaId && item.cleanupOutcome?.kind !== 'cleanup_outcome_uncertain' && !operation.completedSteps.includes(STEP('deleted', item.color)));
      if (uncertainItems.length) {
        for (const item of uncertainItems) { item.uncertainCreation = true; item.status = 'failed'; item.error = 'Shopify file creation may have completed before the process stopped; ownership is uncertain.'; }
        operation.conflictKinds = ['uncertain_file_creation'];
        operation.status = 'conflict'; operation.errors = uncertainItems.map((item) => `${item.color}: interrupted fileCreate requires manual reconciliation; it will not be retried.`);
        await this.checkpoint(operation);
      } else if (uncertainDeletionItems.length) {
        for (const item of uncertainDeletionItems) item.cleanupOutcome = { kind: 'cleanup_outcome_uncertain', mediaId: item.createdMediaId!, recordedAt: new Date().toISOString(), phase: 'file_delete', reason: 'The process stopped after fileDelete intent was persisted; the mutation result is unknown.' };
        operation.conflictKinds = ['cleanup_outcome_uncertain'];
        operation.status = 'conflict'; operation.errors.push('Interrupted fileDelete requires manual reconciliation and will not be retried automatically.'); await this.checkpoint(operation);
      } else if (operation.status === 'publishing') { operation.status = 'partial'; operation.errors.push('Publishing was interrupted; live reconciliation is required before retry.'); await this.checkpoint(operation); }
      if (operation.status === 'rolling_back') { operation.status = 'rollback_partial'; operation.errors.push('Rollback was interrupted; live reconciliation is required before retry.'); await this.checkpoint(operation); }
      this.records.set(operation.id, operation);
    }
  }
  list() { return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string) { this.assertId(id); const operation = this.records.get(id); if (!operation) throw new PublicationError('Publication operation not found.', 404); return operation; }
  async validate(batchId: string): Promise<PublishReadiness> {
    const { batch, state, errors, colors, sourceFreshness } = await this.preflight(batchId);
    const existing = this.list().find((operation) => operation.batchId === batchId);
    if (existing) errors.push(`Batch ${batchId} already has publication operation ${existing.id}; generate a new batch for another publication.`);
    const blocker = this.blockingOperation(batch.productId);
    if (blocker) errors.push(`Publication operation ${blocker.id} must be rolled back or abandoned before a fresh publication.`);
    return { ready: !errors.length, batchId, productId: batch.productId, imageCount: colors.length, variantCount: colors.reduce((sum, item) => sum + item.variantIds.length, 0),
      currentGalleryImageCount: state.mediaIds.length, expectedFinalGalleryImageCount: colors.length, confirmationText: this.publicationConfirmation(batch.productId), replacesGallery: true,
      colors: colors.map(({ color, variantIds, previewId }) => ({ color, variantCount: variantIds.length, previewId })), sourceFreshness, errors };
  }

  async publish(batchId: string, confirmation = 'PUBLISH') {
    const batch = await this.batches.get(batchId).catch(() => { throw new PublicationError('Batch not found.', 404); });
    await this.assertMutationAllowed(batch.productId);
    return this.withLock(batch.productId, async () => {
      const existing = this.list().find((operation) => operation.batchId === batchId);
      if (existing) throw new PublicationError(`Batch ${batchId} already has publication operation ${existing.id}. Generate a new batch for another publication.`, 409);
      const context = await this.preflight(batchId);
      if (context.batch.productId !== batch.productId) throw new PublicationError('The batch product changed during publication startup.', 409);
      if (context.errors.length) throw new PublicationError(context.errors.join(' '), 409);
      if (confirmation !== this.publicationConfirmation(context.batch.productId)) throw new PublicationError(`Explicit publication confirmation for product ${context.batch.productId} is required.`, 400);
      const blocker = this.blockingOperation(context.batch.productId);
      if (blocker) throw new PublicationError(`Publication operation ${blocker.id} must be rolled back, finalized, or abandoned before a fresh publication.`, 409);
      const predecessor = this.latestOperation(context.batch.productId);
      const now = new Date().toISOString();
      const operation: PublicationOperation = { id: crypto.randomUUID(), version: 1, batchId, productId: context.batch.productId, productTitle: context.batch.productTitle,
        createdAt: now, updatedAt: now, status: 'validated', publicationMode: 'replace_gallery', sourceValidationSchemaVersion: 1, predecessorOperationId: predecessor?.id,
        originalMediaOrder: [...context.state.mediaIds], originalVariantMedia: context.state.variants.map((v) => ({ variantId: v.id, mediaIds: [...v.mediaIds] })), expectedPublishedMediaOrder: [],
        items: context.colors.map((item) => { const batchItem = context.batch.items.find((candidate) => candidate.color === item.color)!; return { color: item.color, previewId: item.previewId, variantIds: item.variantIds, sourceProvenance: structuredClone(batchItem.sourceProvenance), generationEvidence: structuredClone(batchItem.generationEvidence), status: 'pending' }; }), completedSteps: [], errors: [] };
      this.records.set(operation.id, operation);
      try { await this.checkpoint(operation); } catch (error) { operation.status = 'conflict'; operation.errors.push('Initial publication checkpoint persistence failed; this process will not start another operation for the product.'); this.records.set(operation.id, structuredClone(operation)); throw error; }
      return this.continuePublication(operation, false, true);
    });
  }

  async validateRecovery(operationId: string, batchId: string): Promise<RecoveryReadiness> {
    const operation = this.get(operationId);
    const errors: string[] = [];
    if (operation.status !== 'partial') errors.push(`Operation ${operation.id} is ${operation.status}, not partial.`);
    if (operation.batchId !== batchId) errors.push('The supplied batch does not match the immutable publication operation.');
    let batch: MockupBatch | undefined;
    if (!errors.length) {
      try { batch = await this.batches.get(batchId); } catch { errors.push('The operation batch metadata is unavailable.'); }
      if (batch && batch.productId !== operation.productId) errors.push('The batch product does not match the immutable publication operation.');
      if (batch && operation.sourceValidationSchemaVersion === 1) {
        const context = await this.preflight(batchId); errors.push(...context.errors.map((error) => `Recovery source validation: ${error}`));
        errors.push(...this.recoverySourceErrors(operation, context.batch, context.colors));
      }
    }
    const blocker = this.blockingOperation(operation.productId, operation.id);
    if (blocker) errors.push(`Publication operation ${blocker.id} also targets this product.`);
    let orderingComplete = false;
    if (!errors.length) {
      const live = await this.shopify.getPublicationState(operation.productId);
      const conflict = this.compareExpected(operation, live, 'publish-retry');
      if (conflict) errors.push(`Recovery blocked: ${conflict}`);
      for (const item of operation.items) {
        if (item.uncertainCreation || (item.intent === 'create_file' && !item.createdMediaId)) errors.push(`${item.color}: file creation ownership is uncertain.`);
        if (item.createdMediaId && operation.completedSteps.includes(STEP('product', item.color)) && !live.mediaIds.includes(item.createdMediaId)) errors.push(`${item.color}: recorded generated product media is missing.`);
        if (item.createdMediaId && operation.completedSteps.includes(STEP('variants', item.color))) {
          for (const variantId of item.variantIds) {
            if (!same(live.variants.find((variant) => variant.id === variantId)?.mediaIds ?? [], [item.createdMediaId])) errors.push(`${item.color}: variant ${variantId} does not have the recorded generated media association.`);
          }
        }
      }
      orderingComplete = same(live.mediaIds, operation.expectedPublishedMediaOrder);
    }
    return { eligible: errors.length === 0, operationId: operation.id, batchId: operation.batchId, productId: operation.productId,
      imageCount: operation.items.length, variantCount: operation.items.reduce((sum, item) => sum + item.variantIds.length, 0),
      orderingComplete: errors.length === 0 && orderingComplete, errors };
  }

  async resume(operationId: string, batchId: string) {
    await this.assertMutationAllowed(this.get(operationId).productId);
    const readiness = await this.validateRecovery(operationId, batchId);
    if (!readiness.eligible) throw new PublicationError(readiness.errors.join(' '), 409);
    return this.continuePublication(this.get(operationId), true);
  }

  private async continuePublication(operation: PublicationOperation, recovering: boolean, lockHeld = false) {
    const action = async () => {
      if (recovering) {
        operation = this.get(operation.id);
        if (operation.status !== 'partial') throw new PublicationError(`Operation ${operation.id} is no longer eligible for recovery.`, 409);
        if (operation.sourceValidationSchemaVersion === 1) {
          const context = await this.preflight(operation.batchId);
          const sourceErrors = [...context.errors, ...this.recoverySourceErrors(operation, context.batch, context.colors)];
          if (sourceErrors.length) throw new PublicationError(`Recovery source validation failed: ${sourceErrors.join(' ')}`, 409);
        }
        const conflict = await this.reconcilePublication(operation); if (conflict) return this.markConflict(operation, conflict);
      }
      operation.status = 'publishing'; operation.errors = []; await this.checkpoint(operation);
      for (const item of operation.items) {
        if (item.status === 'associated') continue;
        if (item.uncertainCreation || (item.intent === 'create_file' && !item.createdMediaId)) return this.markConflict(operation!, `${item.color}: file creation result is uncertain and cannot be safely retried.`);
        try {
          let bytes: Buffer;
          try { bytes = (await this.assets.bytes('preview', item.previewId)).buffer; }
          catch (error) { return this.markConflict(operation!, `${item.color}: preview bytes changed or became unreadable after final source validation; publication stopped before upload. ${error instanceof Error ? error.message : ''}`); }
          if (operation.sourceValidationSchemaVersion === 1 && (!item.generationEvidence || item.generationEvidence.previewAssetId !== item.previewId || item.generationEvidence.previewSha256 !== this.hash(bytes))) return this.markConflict(operation, `${item.color}: preview bytes changed after final source validation; publication stopped before upload.`);
          const filename = `${operation.productTitle}-${item.color}.png`.replace(/[^a-z0-9._-]+/gi, '-');
          if (!item.stagedResourceUrl) { await this.intent(operation, item, 'stage_upload'); item.stagedResourceUrl = await this.shopify.stageImage(filename, bytes); item.intent = undefined; await this.checkpoint(operation); }
          if (!item.createdMediaId) {
            await this.intent(operation!, item, 'create_file');
            try {
              const file = await this.shopify.createImageFile(item.stagedResourceUrl, `${operation!.productTitle} - ${item.color} [${operation!.id}]`);
              item.createdMediaId = file.id; item.status = 'uploaded'; item.intent = undefined; operation!.completedSteps.push(STEP('created', item.color)); operation!.expectedPublishedMediaOrder.push(file.id); await this.checkpoint(operation!);
            } catch (error) {
              if (error instanceof PublicationPersistenceError) throw error;
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
            await this.intent(operation!, item, 'replace_variants'); await this.shopify.replaceVariantMedia(operation!.productId, mediaId, item.variantIds);
            item.intent = undefined; operation!.completedSteps.push(STEP('variants', item.color)); await this.checkpoint(operation!);
          }
          item.status = 'associated'; item.error = undefined; await this.checkpoint(operation!);
        } catch (error) { if (error instanceof PublicationPersistenceError) throw error; item.status = 'failed'; item.error = error instanceof Error ? error.message : 'Publication failed.'; operation!.errors.push(`${item.color}: ${item.error}`); await this.checkpoint(operation!); }
      }
      if (operation!.items.every((item) => item.status === 'associated')) {
        const marker = operation!.items[0];
        if (operation!.publicationMode === 'replace_gallery') {
          try {
            const live = await this.shopify.getPublicationState(operation!.productId);
            for (const originalMediaId of operation!.originalMediaOrder) {
              const step = `removed-original:${originalMediaId}`;
              if (operation!.completedSteps.includes(step)) continue;
              if (live.mediaIds.includes(originalMediaId)) {
                if (marker) await this.intent(operation!, marker, 'remove_original_reference');
                await this.shopify.removeFileFromProduct(originalMediaId, operation!.productId);
                if (marker) marker.intent = undefined;
              }
              operation!.completedSteps.push(step); await this.checkpoint(operation!);
            }
          } catch (error) {
            if (error instanceof PublicationPersistenceError) throw error;
            operation!.status = 'partial'; operation!.errors.push(error instanceof Error ? error.message : 'Original gallery reference removal failed.'); await this.checkpoint(operation!); return operation!;
          }
        }
        if (!operation!.completedSteps.includes('published-order')) {
          try {
            if (marker) await this.intent(operation!, marker, 'reorder_published');
            await this.shopify.reorderMedia(operation!.productId, operation!.expectedPublishedMediaOrder); if (marker) marker.intent = undefined;
            operation!.completedSteps.push('published-order'); await this.checkpoint(operation!);
          } catch (error) {
            if (error instanceof PublicationPersistenceError) throw error;
            operation!.status = 'partial'; operation!.errors.push(error instanceof Error ? error.message : 'Published ordering failed.'); await this.checkpoint(operation!); return operation!;
          }
        }
        const [publishedProduct, publishedState] = await Promise.all([this.shopify.getProduct(operation!.productId, false), this.shopify.getPublicationState(operation!.productId)]);
        const durableConflict = terminalPublicationError(operation!);
        const conflict = durableConflict ?? (publishedProduct.id !== operation!.productId || publishedProduct.title !== operation!.productTitle ? 'product identity changed during publication.' : this.compareExpected(operation!, publishedState, 'published'));
        if (conflict) return this.markConflict(operation!, `Published state verification failed: ${conflict}`);
        operation!.status = 'published';
      } else operation!.status = 'partial';
      await this.checkpoint(operation!); return operation!;
    };
    return lockHeld ? action() : this.withLock(operation.productId, action);
  }

  async rollback(operationId: string, mode: RollbackMode) {
    if (mode !== 'no_global_delete') throw new PublicationError('Explicit no_global_delete rollback mode is required.', 400);
    const operation = this.get(operationId);
    await this.assertMutationAllowed(operation.productId);
    if (!['published', 'partial', 'rollback_partial', 'conflict'].includes(operation.status)) throw new PublicationError('This operation is not eligible for rollback.', 409);
    if (operation.items.some((item) => item.uncertainCreation || (item.intent === 'create_file' && !item.createdMediaId))) throw new PublicationError('Rollback cannot establish ownership of an uncertain file creation; manual reconciliation is required.', 409);
    if (operation.items.some((item) => item.cleanupOutcome?.kind === 'cleanup_outcome_uncertain' || item.intent === 'delete_file')) throw new PublicationError('Rollback cannot retry an uncertain file deletion; manual reconciliation is required.', 409);
    return this.withLock(operation.productId, async () => {
      if (this.isSuperseded(operation)) throw new PublicationError('This operation was superseded by a newer publication checkpoint and can no longer be rolled back.', 409);
      if (operation.rollbackMode && operation.rollbackMode !== mode) throw new PublicationError('Rollback mode does not match the persisted recovery mode.', 409);
      const current = await this.shopify.getPublicationState(operation.productId);
      const conflict = this.compareExpected(operation, current, 'rollback'); if (conflict) return this.markConflict(operation, `Rollback blocked: ${conflict}`);
      operation.rollbackMode = mode; operation.status = 'rolling_back'; operation.errors = []; operation.cleanupConflicts = []; operation.conflictKinds = []; operation.productRestored = false; await this.checkpoint(operation);
      if (operation.publicationMode === 'replace_gallery') {
        const marker = operation.items[0];
        for (const originalMediaId of operation.originalMediaOrder) {
          const step = `restored-original:${originalMediaId}`;
          if (operation.completedSteps.includes(step)) continue;
          try {
            if (!current.mediaIds.includes(originalMediaId)) {
              if (marker) await this.intent(operation, marker, 'restore_original_reference');
              await this.shopify.addFileToProduct(originalMediaId, operation.productId);
              if (marker) marker.intent = undefined;
            }
            operation.completedSteps.push(step); await this.checkpoint(operation);
          } catch (error) {
            if (error instanceof PublicationPersistenceError) throw error;
            operation.status = 'rollback_partial'; operation.errors.push(error instanceof Error ? error.message : `Original media ${originalMediaId} could not be reattached.`); await this.checkpoint(operation); return operation;
          }
        }
      }
      for (const item of [...operation.items].reverse()) {
        if (!item.createdMediaId || (item.status === 'rolled_back' && !item.cleanupPending)) continue;
        try {
          const mediaId = item.createdMediaId;
          const originalByMedia = new Map<string, string[]>(); const originallyUnassigned: string[] = [];
          for (const variantId of item.variantIds) {
            const original = operation.originalVariantMedia.find((variant) => variant.variantId === variantId)?.mediaIds ?? [];
            if (original.length > 1) return this.markConflict(operation, `${item.color}: original variant ${variantId} has multiple media associations and cannot be restored automatically.`);
            if (!original.length) originallyUnassigned.push(variantId);
            else originalByMedia.set(original[0], [...(originalByMedia.get(original[0]) ?? []), variantId]);
          }
          for (const [originalMediaId, variantIds] of originalByMedia) {
            const step = `restored-variants:${item.color}:${originalMediaId}`;
            if (operation.completedSteps.includes(step)) continue;
            const restoredCount = variantIds.filter((variantId) => same(current.variants.find((variant) => variant.id === variantId)?.mediaIds ?? [], [originalMediaId])).length;
            if (restoredCount === variantIds.length) { operation.completedSteps.push(step); await this.checkpoint(operation); continue; }
            if (restoredCount > 0) return this.markConflict(operation, `${item.color}: only some variants reflect the original media association; manual review is required.`);
            await this.intent(operation, item, 'restore_variants'); await this.shopify.replaceVariantMedia(operation.productId, originalMediaId, variantIds);
            item.intent = undefined; operation.completedSteps.push(step); await this.checkpoint(operation);
          }
          const stillGenerated = current.variants.filter((variant) => originallyUnassigned.includes(variant.id) && variant.mediaIds.includes(mediaId)).map((variant) => variant.id);
          const detachedStep = STEP('detached', item.color);
          if (stillGenerated.length) { await this.intent(operation, item, 'detach_variants'); await this.shopify.detachVariantMedia(operation.productId, mediaId, stillGenerated); item.intent = undefined; operation.completedSteps.push(detachedStep); await this.checkpoint(operation); }
          else if (originallyUnassigned.length && !operation.completedSteps.includes(detachedStep)) { if (item.intent === 'detach_variants') item.intent = undefined; operation.completedSteps.push(detachedStep); await this.checkpoint(operation); }
          const removedReferenceStep = STEP('removed-reference', item.color);
          if (current.mediaIds.includes(mediaId)) { await this.intent(operation, item, 'remove_product_reference'); await this.shopify.removeFileFromProduct(mediaId, operation.productId); item.intent = undefined; operation.completedSteps.push(removedReferenceStep); await this.checkpoint(operation); }
          else if (!operation.completedSteps.includes(removedReferenceStep)) { if (item.intent === 'remove_product_reference') item.intent = undefined; operation.completedSteps.push(removedReferenceStep); await this.checkpoint(operation); }
          item.status = 'rolled_back'; item.cleanupPending = true;
          item.cleanupOutcome = { kind: 'retained_by_operator', mediaId, recordedAt: new Date().toISOString(), reasonCode: 'global_deletion_prohibited_by_operator', reason: 'Generated Shopify File retained because the operator explicitly prohibited global deletion.' };
          if (!operation.conflictKinds.includes('retained_file_deletion_prohibited')) operation.conflictKinds.push('retained_file_deletion_prohibited');
          operation.cleanupConflicts.push(`${item.color}: generated Shopify File deliberately retained; global deletion was prohibited by the operator.`);
          item.error = undefined; await this.checkpoint(operation);
        } catch (error) {
          if (error instanceof PublicationPersistenceError) throw error;
          item.error = error instanceof Error ? error.message : 'Rollback failed.';
          if (item.createdMediaId && item.intent === 'delete_file') item.cleanupOutcome = { kind: 'cleanup_outcome_uncertain', mediaId: item.createdMediaId, recordedAt: new Date().toISOString(), phase: 'file_delete', reason: item.error };
          const conflictKind = item.cleanupOutcome?.kind === 'cleanup_outcome_uncertain' ? 'cleanup_outcome_uncertain' : 'cleanup_failed';
          if (!operation.conflictKinds.includes(conflictKind)) operation.conflictKinds.push(conflictKind);
          operation.errors.push(`${item.color}: ${item.error}`); await this.checkpoint(operation);
          if (conflictKind === 'cleanup_outcome_uncertain') { operation.status = 'conflict'; await this.checkpoint(operation); return operation; }
        }
      }
      if (operation.items.every((item) => !item.createdMediaId || item.status === 'rolled_back')) {
        const marker = operation.items[0]; if (marker) await this.intent(operation, marker, 'restore_order'); await this.shopify.reorderMedia(operation.productId, operation.originalMediaOrder); if (marker) marker.intent = undefined;
        operation.completedSteps.push('original-order-restored'); await this.checkpoint(operation);
        const live = await this.shopify.getPublicationState(operation.productId);
        const restored = !snapshotStructureError(live) && same(live.mediaIds, operation.originalMediaOrder) && !exactVariantError(operation.originalVariantMedia, live.variants);
        operation.productRestored = restored;
        if (!restored) { operation.status = 'conflict'; operation.conflictKinds.push('restoration_mismatch'); operation.errors.push('Product restoration did not match the immutable original snapshot.'); }
        else if (operation.cleanupConflicts.length) operation.status = 'conflict';
        else operation.status = 'rolled_back';
      } else operation.status = 'rollback_partial';
      await this.checkpoint(operation); return operation;
    });
  }

  async validateAbandonment(operationId: string): Promise<AbandonReadiness> {
    const operation = this.get(operationId);
    if (operation.status === 'abandoned') return { eligible: true, alreadyAbandoned: true, operationId, productId: operation.productId, errors: [], evidence: operation.abandonmentEvidence };
    return this.abandonmentReadiness(operation);
  }

  async abandon(operationId: string, reason: string) {
    const operation = this.get(operationId);
    await this.assertMutationAllowed(operation.productId);
    if (operation.status === 'abandoned') return operation;
    if (reason.trim().length < 10 || reason.length > 500) throw new PublicationError('Provide an abandonment reason between 10 and 500 characters.', 400);
    return this.withLock(operation.productId, async () => {
      if (operation.status === 'abandoned') return operation;
      const readiness = await this.abandonmentReadiness(operation);
      if (!readiness.eligible || !readiness.evidence) throw new PublicationError(readiness.errors.join(' '), 409);
      operation.status = 'abandoned'; operation.abandonedAt = new Date().toISOString(); operation.abandonmentReason = reason.trim();
      operation.abandonmentEvidence = readiness.evidence; operation.errors = [...operation.errors, `Operation abandoned after verified manual restoration: ${reason.trim()}`];
      await this.checkpoint(operation); return operation;
    });
  }

  async validateRollbackFinalization(operationId: string): Promise<RollbackFinalizationReadiness> {
    return this.rollbackFinalizationReadiness(this.get(operationId));
  }

  async finalizeRollback(operationId: string, confirmation: string) {
    const initial = this.get(operationId);
    await this.assertMutationAllowed(initial.productId);
    const expectedConfirmation = `FINALIZE ${operationId} FILES RETAINED`;
    if (confirmation !== expectedConfirmation) throw new PublicationError('Explicit retained-files finalization confirmation with the operation ID is required.', 400);
    return this.withLock(initial.productId, async () => {
      const operation = this.get(operationId);
      if (this.isSuperseded(operation)) throw new PublicationError('This rollback was superseded by a newer publication checkpoint and cannot be finalized.', 409);
      if (operation.status !== 'conflict') throw new PublicationError('This operation is no longer eligible for rollback finalization.', 409);
      const readiness = await this.rollbackFinalizationReadiness(operation);
      if (!readiness.eligible || !readiness.evidence) throw new PublicationError(readiness.errors.join(' '), 409);
      const finalizedAt = new Date().toISOString();
      operation.rollbackFinalizedAt = finalizedAt;
      operation.rollbackFinalizationEvidence = { ...readiness.evidence, finalizedAt, previousStatus: 'conflict', newStatus: 'rolled_back_files_retained', confirmation };
      for (const item of operation.items) { item.cleanupPending = false; item.cleanupDisposition = 'retained_manual_ownership_review'; }
      operation.status = 'rolled_back_files_retained';
      await this.checkpoint(operation);
      return operation;
    });
  }

  private async rollbackFinalizationReadiness(operation: PublicationOperation): Promise<RollbackFinalizationReadiness> {
    const errors: string[] = [];
    errors.push(...operationIntegrityErrors(operation).map((error) => `Checkpoint integrity: ${error}.`));
    const generated = operation.items.map((item) => item.createdMediaId).filter((id): id is string => Boolean(id));
    if (operation.status !== 'conflict') errors.push('Only a conflicted operation can be finalized.');
    const disposableTestProduct = operation.productId === ABANDONMENT_TEST_PRODUCT_ID && operation.productTitle === ABANDONMENT_TEST_PRODUCT_TITLE;
    if (!disposableTestProduct && !this.allowedProductIds.has(operation.productId)) errors.push('The product is not the designated disposable test product or an explicitly allowlisted real product.');
    if (this.isSuperseded(operation)) errors.push('A newer publication checkpoint supersedes this rollback.');
    if (operation.productRestored !== true) errors.push('Product restoration has not been recorded as complete.');
    if (!operation.items.length || operation.items.some((item) => item.status !== 'rolled_back')) errors.push('Every publication item must be rolled back.');
    if (!generated.length || generated.length !== operation.items.length || new Set(generated).size !== generated.length) errors.push('Generated media ownership records are incomplete or inconsistent.');
    if (operation.items.some((item) => !item.createdMediaId || item.cleanupPending !== true || item.error)) errors.push('Every retained generated file must be cleanup-pending and have no item error.');
    const outcomeKinds = new Set(operation.items.map((item) => item.cleanupOutcome?.kind));
    const ownershipRetention = outcomeKinds.size === 1 && outcomeKinds.has('retained_ownership_unproven') && operation.items.every((item) => item.cleanupOutcome?.kind === 'retained_ownership_unproven' && item.cleanupOutcome.reasonCode === 'global_references_unverifiable' && item.cleanupOutcome.mediaId === item.createdMediaId);
    const operatorRetention = outcomeKinds.size === 1 && outcomeKinds.has('retained_by_operator') && operation.items.every((item) => item.cleanupOutcome?.kind === 'retained_by_operator' && item.cleanupOutcome.reasonCode === 'global_deletion_prohibited_by_operator' && item.cleanupOutcome.mediaId === item.createdMediaId);
    if (!ownershipRetention && !operatorRetention) errors.push('Every generated file requires one consistent machine-readable retained-file outcome. Legacy or mixed cleanup outcomes require manual review.');
    const expectedConflictKind = operatorRetention ? 'retained_file_deletion_prohibited' : 'retained_file_ownership_unproven';
    if (!operation.conflictKinds || operation.conflictKinds.length !== 1 || operation.conflictKinds[0] !== expectedConflictKind) errors.push('The operation contains a non-retained-file conflict classification or lacks consistent structured conflict evidence.');
    if (operation.errors.length > 0) errors.push('The operation contains unresolved errors in addition to its structured cleanup outcome.');
    if (!operation.completedSteps.includes('original-order-restored')) errors.push('Original media ordering was not checkpointed as restored.');
    for (const item of operation.items) {
      if (!operation.completedSteps.includes(STEP('removed-reference', item.color))) errors.push(`${item.color}: generated product reference removal was not checkpointed.`);
      for (const variantId of item.variantIds) {
        const original = operation.originalVariantMedia.find((entry) => entry.variantId === variantId)?.mediaIds;
        if (!original) errors.push(`${item.color}: immutable variant ${variantId} is missing.`);
        else if (original.length === 0 && !operation.completedSteps.includes(STEP('detached', item.color))) errors.push(`${item.color}: generated variant detachment was not checkpointed.`);
        else if (original.length === 1 && !operation.completedSteps.includes(`restored-variants:${item.color}:${original[0]}`)) errors.push(`${item.color}: original variant restoration was not checkpointed.`);
        else if (original.length > 1) errors.push(`${item.color}: immutable variant association is ambiguous.`);
      }
    }
    const mediaSet = new Set(operation.originalMediaOrder); const variantIds = operation.originalVariantMedia.map((entry) => entry.variantId);
    if (!operation.originalMediaOrder.length || mediaSet.size !== operation.originalMediaOrder.length) errors.push('Immutable original media snapshot is empty or contains duplicates.');
    if (!variantIds.length || new Set(variantIds).size !== variantIds.length) errors.push('Immutable original variant snapshot is empty or contains duplicates.');
    if (operation.originalVariantMedia.some((entry) => entry.mediaIds.some((id) => !mediaSet.has(id)))) errors.push('Immutable variant associations reference media outside the original snapshot.');
    const mappedVariantIds = operation.items.flatMap((item) => item.variantIds);
    if (mappedVariantIds.length !== variantIds.length || new Set(mappedVariantIds).size !== mappedVariantIds.length || variantIds.some((id) => !mappedVariantIds.includes(id))) errors.push('Immutable item-to-variant mapping is incomplete or inconsistent.');
    if (errors.length) return { eligible: false, operationId: operation.id, productId: operation.productId, retainedFileCount: generated.length, errors };

    const [product, state] = await Promise.all([this.shopify.getProduct(operation.productId, false), this.shopify.getPublicationState(operation.productId)]);
    const structureError = snapshotStructureError(state); if (structureError) errors.push(structureError);
    if (product.id !== operation.productId || product.title !== operation.productTitle) errors.push('The live Shopify product identity does not match the immutable operation.');
    if (disposableTestProduct && product.status.toUpperCase() !== 'DRAFT') errors.push('The designated disposable test product is no longer Draft.');
    if (!same(state.mediaIds, operation.originalMediaOrder)) errors.push('Live product media IDs or ordering do not match the immutable original snapshot.');
    if (state.variants.length !== operation.originalVariantMedia.length) errors.push('The live variant set does not match the immutable original snapshot.');
    const originals = new Map(operation.originalVariantMedia.map((entry) => [entry.variantId, entry.mediaIds]));
    for (const variant of state.variants) {
      const original = originals.get(variant.id);
      if (!original || !same(variant.mediaIds, original)) errors.push(`Variant ${variant.id} is unexpected or its media association does not match the immutable snapshot.`);
    }
    for (const original of operation.originalVariantMedia) if (!state.variants.some((variant) => variant.id === original.variantId)) errors.push(`Original variant ${original.variantId} is missing.`);
    if (generated.some((id) => state.mediaIds.includes(id))) errors.push('Generated media remains attached to the product.');
    if (state.variants.some((variant) => variant.mediaIds.some((id) => generated.includes(id)))) errors.push('Generated media remains associated with a variant.');
    const evidence: RollbackFinalizationEvidence | undefined = errors.length ? undefined : {
      verifiedAt: new Date().toISOString(), operationId: operation.id, productId: product.id, productTitle: product.title, productStatus: product.status,
      snapshotComplete: true, originalMediaIdsVerified: [...state.mediaIds],
      originalVariantAssociationsVerified: state.variants.map((variant) => ({ variantId: variant.id, mediaIds: [...variant.mediaIds] })),
      retainedGeneratedMediaIds: [...generated], retainedFileConflicts: [...(operation.cleanupConflicts ?? [])],
      retainedFileOutcomes: operation.items.map((item) => structuredClone(item.cleanupOutcome!)), cleanupReason: operatorRetention ? 'global_deletion_prohibited_by_operator' : 'global_file_deletion_ownership_unproven'
    };
    return { eligible: errors.length === 0, operationId: operation.id, productId: operation.productId, retainedFileCount: generated.length, errors, evidence };
  }

  private async abandonmentReadiness(operation: PublicationOperation): Promise<AbandonReadiness> {
    const errors: string[] = [];
    if (operation.productId !== ABANDONMENT_TEST_PRODUCT_ID) errors.push('Only the designated disposable Phase 4 test product can be abandoned.');
    if (!['partial', 'conflict', 'rollback_partial'].includes(operation.status)) errors.push('Only a partial or conflicted test publication can be abandoned.');
    if (errors.length) return { eligible: false, operationId: operation.id, productId: operation.productId, errors };
    const [product, state] = await Promise.all([this.shopify.getProduct(operation.productId, false), this.shopify.getPublicationState(operation.productId)]);
    const structureError = snapshotStructureError(state); if (structureError) errors.push(structureError);
    if (product.id !== ABANDONMENT_TEST_PRODUCT_ID || product.title !== ABANDONMENT_TEST_PRODUCT_TITLE || product.status.toUpperCase() !== 'DRAFT') errors.push('The operation does not target the designated disposable draft product.');
    if (!same(state.mediaIds, operation.originalMediaOrder)) errors.push('Current product media IDs or ordering do not exactly match the immutable original snapshot.');
    const originals = new Map(operation.originalVariantMedia.map((entry) => [entry.variantId, entry.mediaIds]));
    if (state.variants.length !== operation.originalVariantMedia.length) errors.push('The current variant set does not match the immutable original snapshot.');
    for (const variant of state.variants) {
      const original = originals.get(variant.id);
      if (!original || !same(variant.mediaIds, original)) errors.push(`Variant ${variant.id} is missing or its media association changed.`);
    }
    for (const original of operation.originalVariantMedia) if (!state.variants.some((variant) => variant.id === original.variantId)) errors.push(`Original variant ${original.variantId} is missing.`);
    const generated = operation.items.map((item) => item.createdMediaId).filter((id): id is string => Boolean(id));
    const generatedOnProduct = generated.filter((id) => state.mediaIds.includes(id));
    const generatedOnVariants = state.variants.flatMap((variant) => variant.mediaIds.filter((id) => generated.includes(id)).map((id) => `${variant.id}:${id}`));
    if (generatedOnProduct.length) errors.push(`Generated media remains attached to the product: ${generatedOnProduct.join(', ')}.`);
    if (generatedOnVariants.length) errors.push(`Generated media remains attached to variants: ${generatedOnVariants.join(', ')}.`);
    const evidence: AbandonmentEvidence | undefined = errors.length ? undefined : {
      verifiedAt: new Date().toISOString(), productId: product.id, productTitle: product.title, productStatus: product.status,
      mediaIds: [...state.mediaIds], variantAssociations: state.variants.map((variant) => ({ variantId: variant.id, mediaIds: [...variant.mediaIds] })),
      generatedMediaIdsChecked: generated, snapshotComplete: true
    };
    return { eligible: errors.length === 0, operationId: operation.id, productId: operation.productId, errors, evidence };
  }

  private async reconcilePublication(operation: PublicationOperation) {
    if (operation.items.some((item) => item.uncertainCreation || (item.intent === 'create_file' && !item.createdMediaId))) return 'A fileCreate result is uncertain; manual ownership reconciliation is required and fileCreate will not be retried.';
    const live = await this.shopify.getPublicationState(operation.productId); const conflict = this.compareExpected(operation, live, 'publish-retry'); if (conflict) return conflict;
    for (const item of operation.items) {
      if (!item.createdMediaId) continue; const onProduct = live.mediaIds.includes(item.createdMediaId);
      const associatedCount = item.variantIds.filter((id) => same(live.variants.find((v) => v.id === id)?.mediaIds ?? [], [item.createdMediaId!])).length;
      if (associatedCount > 0 && associatedCount < item.variantIds.length) return `${item.color}: only some intended variants have the generated media; manual review is required.`;
      const associated = associatedCount === item.variantIds.length;
      if (onProduct && !operation.completedSteps.includes(STEP('product', item.color))) operation.completedSteps.push(STEP('product', item.color));
      if (associated && !operation.completedSteps.includes(STEP('variants', item.color))) operation.completedSteps.push(STEP('variants', item.color));
      if (associated) item.status = 'associated';
    }
    if (operation.publicationMode === 'replace_gallery') for (const originalMediaId of operation.originalMediaOrder) {
      const step = `removed-original:${originalMediaId}`;
      if (!live.mediaIds.includes(originalMediaId) && !operation.completedSteps.includes(step)) operation.completedSteps.push(step);
    }
    const reorderMarker = operation.items.find((item) => item.intent === 'reorder_published');
    if (reorderMarker && same(live.mediaIds, operation.expectedPublishedMediaOrder)) {
      reorderMarker.intent = undefined;
      if (!operation.completedSteps.includes('published-order')) operation.completedSteps.push('published-order');
    }
    await this.checkpoint(operation); return undefined;
  }

  private compareExpected(operation: PublicationOperation, live: ShopifyPublicationState, mode: 'publish-retry' | 'published' | 'rollback') {
    const snapshotError = snapshotStructureError(live); if (snapshotError) return snapshotError;
    if (!live.complete) return 'Shopify returned an incomplete publication snapshot.';
    const replacesGallery = operation.publicationMode === 'replace_gallery';
    const created = operation.items.map((item) => item.createdMediaId).filter((id): id is string => Boolean(id)); const allowed = new Set([...operation.originalMediaOrder, ...created]);
    if (live.mediaIds.some((id) => !allowed.has(id))) return 'unrelated product media changed externally.';
    if (!replacesGallery && operation.originalMediaOrder.some((id) => !live.mediaIds.includes(id))) return 'original product media is missing.';
    if (replacesGallery && mode === 'publish-retry') for (const originalMediaId of operation.originalMediaOrder) {
      const removalRecorded = operation.completedSteps.includes(`removed-original:${originalMediaId}`);
      if (removalRecorded && live.mediaIds.includes(originalMediaId)) return `original media ${originalMediaId} removal state conflicts with its checkpoint.`;
    }
    if (mode !== 'rollback') for (const item of operation.items) {
      if (item.createdMediaId && operation.completedSteps.includes(STEP('product', item.color)) && !live.mediaIds.includes(item.createdMediaId)) return `${item.color} product media reference changed externally.`;
    }
    if (!same(live.mediaIds.filter((id) => operation.originalMediaOrder.includes(id)), operation.originalMediaOrder.filter((id) => live.mediaIds.includes(id)))) return 'original product media ordering changed externally.';
    if (mode === 'published' && !same(live.mediaIds, operation.expectedPublishedMediaOrder)) return 'published media ordering does not match the recorded order.';
    const originals = new Map(operation.originalVariantMedia.map((entry) => [entry.variantId, entry.mediaIds]));
    for (const variant of live.variants) {
      if (!originals.has(variant.id)) return `unexpected variant ${variant.id}.`;
      const original = [...originals.get(variant.id)!];
      const item = operation.items.find((candidate) => candidate.variantIds.includes(variant.id) && candidate.createdMediaId);
      if (!item?.createdMediaId) { if (!same(variant.mediaIds, original)) return `variant ${variant.id} media changed externally.`; continue; }
      const generated = [item.createdMediaId];
      if (mode === 'published') { if (!same(variant.mediaIds, generated)) return `variant ${variant.id} media changed externally.`; continue; }
      if (mode === 'rollback') { if (!same(variant.mediaIds, original) && !same(variant.mediaIds, generated)) return `variant ${variant.id} media changed externally.`; continue; }
      const replacementRecorded = operation.completedSteps.includes(STEP('variants', item.color));
      const replacementPending = item.intent === 'replace_variants' || item.intent === 'append_variants';
      if (replacementRecorded) { if (!same(variant.mediaIds, generated)) return `variant ${variant.id} media changed externally.`; }
      else if (replacementPending) { if (!same(variant.mediaIds, original) && !same(variant.mediaIds, generated)) return `variant ${variant.id} media changed externally.`; }
      else if (!same(variant.mediaIds, original)) return `variant ${variant.id} media changed externally.`;
    }
    if (live.variants.length !== operation.originalVariantMedia.length) return 'the product variant set changed externally.';
    return undefined;
  }

  private async preflight(batchId: string) {
    const errors: string[] = []; let batch: MockupBatch; try { batch = await this.batches.get(batchId); } catch { throw new PublicationError('Batch not found.', 404); }
    if (batch.status !== 'completed') errors.push('The selected batch must be fully completed with no failed or skipped colors.');
    const [product, state] = await Promise.all([this.shopify.getProduct(batch.productId, false), this.shopify.getPublicationState(batch.productId)]);
    const structureError = snapshotStructureError(state); if (structureError) errors.push(structureError);
    const productVariantIds = product.variants.map((variant) => variant.id); const stateVariantIds = state.variants.map((variant) => variant.id);
    if (duplicates(productVariantIds) || productVariantIds.length !== stateVariantIds.length || productVariantIds.some((id) => !stateVariantIds.includes(id))) errors.push('The complete publication snapshot variant set does not match the live product variant set.');
    const disposableTestProduct = product.id === ABANDONMENT_TEST_PRODUCT_ID && product.title === ABANDONMENT_TEST_PRODUCT_TITLE && product.status.toUpperCase() === 'DRAFT';
    if (!disposableTestProduct && !this.allowedProductIds.has(product.id)) errors.push('This Shopify product is not approved by the server-side publishing allowlist.');
    if (product.id !== batch.productId || product.title !== batch.productTitle) errors.push('The live Shopify product identity does not match the completed batch.');
    const colors: Array<{ color: string; variantIds: string[]; previewId: string }> = [];
    const sourceFreshness: NonNullable<PublishReadiness['sourceFreshness']> = [];
    for (const item of batch.items) {
      if (item.status !== 'success' || !item.preview || !item.sourceImageId) { errors.push(`${item.color}: generated preview or reliable source mapping is missing.`); sourceFreshness.push({ color: item.color, state: item.sourceFreshness?.state ?? 'provenance_missing', reason: item.reason ?? 'Generated preview or source mapping is missing.' }); continue; }
      const sourceImageId = item.sourceImageId; const variants = product.variants.filter((variant) => variant.color === item.color);
      if (!variants.length) { errors.push(`${item.color}: current Shopify variants no longer contain this color.`); continue; }
      const provenance = item.sourceProvenance; const generation = item.generationEvidence;
      if (!provenance) { const reason = 'Source provenance is missing; historical cached artwork cannot establish current freshness.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'provenance_missing', reason }); continue; }
      const assetProvenance = item.sourceAsset?.provenance;
      if (provenance.schemaVersion !== 1 || provenance.productId !== batch.productId || provenance.color !== item.color || provenance.assetId !== item.sourceAsset?.id || !provenance.mediaId.startsWith('gid://shopify/MediaImage/') || !assetProvenance || assetProvenance.assetId !== provenance.assetId || assetProvenance.sha256 !== provenance.sha256 || assetProvenance.productId !== provenance.productId || assetProvenance.color !== provenance.color || assetProvenance.mediaId !== provenance.mediaId) { const reason = 'Source provenance is incomplete or does not match this product, color, and asset.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'provenance_missing', reason }); continue; }
      let sourceBytes: Buffer; let backgroundBytes: Buffer; let previewBytes: Buffer;
      try {
        sourceBytes = (await this.assets.bytes('garment', provenance.assetId)).buffer;
        backgroundBytes = (await this.assets.bytes('background', batch.backgroundId)).buffer;
        previewBytes = (await this.assets.bytes('preview', item.preview.id)).buffer;
        await inspectImage(previewBytes, ['png']);
      } catch (error) { const reason = `Source bytes or background/preview hash evidence is missing, unreadable, or invalid${error instanceof Error ? `: ${error.message}` : '.'}`; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_unavailable', reason }); continue; }
      const sourceHash = this.hash(sourceBytes); const backgroundHash = this.hash(backgroundBytes); const previewHash = this.hash(previewBytes);
      if (sourceHash !== provenance.sha256 || (item.sourceAsset?.sha256 && item.sourceAsset.sha256 !== sourceHash)) { const reason = 'Preserved source bytes no longer match their recorded SHA-256 hash.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_changed', reason }); continue; }
      if (!(await analyzeTransparency(sourceBytes)).isMeaningfullyTransparent) { const reason = 'Preserved garment source is no longer meaningfully transparent.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_changed', reason }); continue; }
      if (!generation || generation.sourceAssetId !== provenance.assetId || generation.sourceSha256 !== sourceHash || generation.backgroundAssetId !== batch.backgroundId || generation.backgroundSha256 !== backgroundHash || generation.previewAssetId !== item.preview.id || generation.previewSha256 !== previewHash) { const reason = 'Preview/source/background hash evidence does not match the generated batch.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_changed', reason }); continue; }
      const candidates = product.images.filter((image) => image.association === 'reliable' && image.associatedColors.length === 1 && image.associatedColors[0] === item.color);
      if (candidates.length !== 1) { const reason = 'Shopify does not expose exactly one reliable current source; the cached source remains historical and unverified.'; errors.push(`${item.color}: ${reason}`); sourceFreshness.push({ color: item.color, state: candidates.length ? 'historical_unverified' : 'source_unavailable', reason }); continue; }
      const current = candidates[0];
      if (current.id !== sourceImageId || current.mediaId !== provenance.mediaId || variants.some((variant) => !variant.associatedImageIds.includes(current.id) && !variant.associatedImageIds.includes(provenance.mediaId))) { const reason = 'Current Shopify variant-to-color source mapping conflicts with the provenance record.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_changed', reason }); continue; }
      try {
        const currentBytes = await this.shopify.downloadImage(current.url); const info = await inspectImage(currentBytes, ['png']);
        if (info.format !== 'png' || !(await analyzeTransparency(currentBytes)).isMeaningfullyTransparent) throw new Error('not a transparent PNG');
        if (this.hash(currentBytes) !== provenance.sha256) { const reason = 'Current Shopify source artwork changed after batch generation.'; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_changed', reason }); continue; }
      } catch (error) { const reason = `Current Shopify source is unavailable or invalid${error instanceof Error ? `: ${error.message}` : '.'}`; errors.push(`${item.color}: ${reason.toLowerCase()}`); sourceFreshness.push({ color: item.color, state: 'source_unavailable', reason }); continue; }
      sourceFreshness.push({ color: item.color, state: 'verified_current', reason: 'Current Shopify source bytes and variant associations match the generated batch provenance.' });
      colors.push({ color: item.color, variantIds: variants.map((v) => v.id), previewId: item.preview.id });
    }
    const uniqueProductColors = new Set(product.variants.map((variant) => variant.color).filter((color): color is string => Boolean(color)));
    const batchColors = new Set(colors.map((item) => item.color));
    if (product.variants.some((variant) => !variant.color)) errors.push('Every Shopify variant must have an identifiable color option.');
    if (batchColors.size !== colors.length) errors.push('The batch contains duplicate color outputs.');
    for (const color of uniqueProductColors) if (!batchColors.has(color)) errors.push(`${color}: exactly one successful generated mockup is required.`);
    if (batchColors.size !== uniqueProductColors.size) errors.push('The generated color set does not exactly match the Shopify variant color set.');
    const mappedVariantIds = colors.flatMap((item) => item.variantIds);
    if (mappedVariantIds.length !== product.variants.length || new Set(mappedVariantIds).size !== mappedVariantIds.length || product.variants.some((variant) => !mappedVariantIds.includes(variant.id))) errors.push('Every Shopify variant must map exactly once to its generated color image.');
    if (colors.some((item) => item.variantIds.length > 250)) errors.push('A color exceeds Shopify’s 250-item mutation input limit.');
    return { batch, state, errors, colors, sourceFreshness };
  }

  private hash(buffer: Buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

  private recoverySourceErrors(operation: PublicationOperation, batch: MockupBatch, colors: Array<{ color: string; variantIds: string[]; previewId: string }>) {
    const errors: string[] = [];
    for (const operationItem of operation.items) {
      const batchItem = batch.items.find((item) => item.color === operationItem.color); const current = colors.find((item) => item.color === operationItem.color);
      if (!batchItem || !current || current.previewId !== operationItem.previewId || batchItem.preview?.id !== operationItem.previewId) { errors.push(`${operationItem.color}: batch preview no longer matches the immutable publication operation.`); continue; }
      if (!same(current.variantIds, operationItem.variantIds)) errors.push(`${operationItem.color}: current variant mapping no longer matches the immutable publication operation.`);
      if (JSON.stringify(batchItem.sourceProvenance) !== JSON.stringify(operationItem.sourceProvenance) || JSON.stringify(batchItem.generationEvidence) !== JSON.stringify(operationItem.generationEvidence)) errors.push(`${operationItem.color}: source or generation evidence changed after publication started.`);
    }
    return errors;
  }

  private publicationConfirmation(productId: string) { return productId === ABANDONMENT_TEST_PRODUCT_ID ? 'PUBLISH' : `PUBLISH ${productId}`; }

  private async intent(operation: PublicationOperation, item: PublicationItem, intent: NonNullable<PublicationItem['intent']>) { await this.assertMutationAllowed(operation.productId); item.intent = intent; await this.checkpoint(operation); }
  private async markConflict(operation: PublicationOperation, message: string) { operation.status = 'conflict'; operation.conflictKinds ??= []; if (!operation.conflictKinds.includes('external_state_conflict')) operation.conflictKinds.push('external_state_conflict'); if (!operation.errors.includes(message)) operation.errors.push(message); await this.checkpoint(operation); return operation; }
  private async checkpoint(operation: PublicationOperation) {
    const updatedAt = new Date().toISOString(); const durable = structuredClone({ ...operation, updatedAt });
    try {
      const directory = path.join(this.folder, operation.id); await mkdir(directory, { recursive: true });
      const files = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)); const sequence = files.length ? Math.max(...files.map((name) => Number(name.slice(0, 6)))) + 1 : 0;
      const finalPath = path.join(directory, `${String(sequence).padStart(6, '0')}.json`);
      await this.checkpointWriter(finalPath, JSON.stringify(durable, null, 2));
      operation.updatedAt = updatedAt; this.records.set(operation.id, durable);
    } catch (error) {
      this.persistenceBlockedProducts.add(operation.productId);
      throw new PublicationPersistenceError(`Publication persistence failed for product ${operation.productId}; further state transitions are blocked until process restart and checkpoint reconciliation.`, error);
    }
  }
  private async readLatest(id: string) {
    const directory = path.join(this.folder, id); const files = (await readdir(directory)).filter((name) => /^\d{6}\.json$/.test(name)).sort().reverse();
    for (const file of files) {
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path.join(directory, file), 'utf8')); }
      catch { continue; /* fall back from an incomplete or malformed write */ }
      return validatePublicationCheckpointData(parsed, id, file);
    }
    throw new PublicationError('No complete publication checkpoint was found.', 409);
  }
  private blockingOperation(productId: string, allowedOperationId?: string) {
    return this.list().find((operation) => operation.productId === productId && operation.id !== allowedOperationId && !NONBLOCKING_STATUSES.has(operation.status));
  }
  private latestOperation(productId: string) { return this.list().find((operation) => operation.productId === productId); }
  private isSuperseded(operation: PublicationOperation) {
    return this.list().some((candidate) => candidate.productId === operation.productId && candidate.predecessorOperationId === operation.id);
  }
  private async withLock<T>(productId: string, action: () => Promise<T>) { if (this.locks.has(productId)) throw new PublicationError('Another publication or rollback is already running for this product.', 409); this.locks.add(productId); try { return await action(); } finally { this.locks.delete(productId); } }
  private async assertMutationAllowed(productId: string) {
    if (this.persistenceBlockedProducts.has(productId)) throw new PublicationError('Local publication persistence previously failed for this product. Restart the API and reconcile the latest durable checkpoint before any further state transition.', 503);
    try { await access(this.restorationMarker); throw new PublicationError('Restored local data requires complete operator-controlled Shopify reconciliation before any publication, recovery, rollback, abandonment, or finalization transition. Marker clearing is not implemented.', 503); }
    catch (error) { if (error instanceof PublicationError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PublicationError('Restoration reconciliation state could not be verified; all publication transitions are blocked.', 503); }
  }
  private assertId(id: string) { if (!STRICT_UUID.test(id)) throw new PublicationError('Publication operation not found.', 404); }
}
