import crypto from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { GarmentSourceProvenance, MockupBatch, MockupBatchItem, ShopifyProductDetail } from '@mockup-automation/shared';
import { AssetStore } from './storage.js';
import { analyzeTransparency, compositePreview, inspectImage } from './images.js';
import { ShopifyError, ShopifyService } from './shopify.js';
import { createStoredZip } from './zip.js';

const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH_ITEMS = 50;
const MAX_ACTIVE_BATCHES = 2;
const MAX_ZIP_BYTES = 150 * 1024 * 1024;

type ShopifyReader = Pick<ShopifyService, 'getProduct' | 'downloadImage'>;

export class BatchError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class BatchService {
  private readonly folder: string;
  private readonly active = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly records = new Map<string, MockupBatch>();

  constructor(
    dataDir: string,
    private readonly assets: AssetStore,
    private readonly shopify: ShopifyReader,
    private readonly concurrency = 2,
    private readonly compositor = compositePreview
  ) { this.folder = path.join(dataDir, 'batches'); }

  async init() {
    await mkdir(this.folder, { recursive: true });
    for (const filename of await readdir(this.folder)) {
      if (!filename.endsWith('.json')) continue;
      try {
        const batch = JSON.parse(await readFile(path.join(this.folder, filename), 'utf8')) as MockupBatch;
        this.records.set(batch.id, batch);
        if (batch.status === 'running') {
          for (const item of batch.items) if (item.status === 'queued' || item.status === 'processing') { item.status = 'failed'; item.reason = 'Interrupted before completion; regenerate this color.'; }
          batch.status = 'partial'; batch.updatedAt = new Date().toISOString(); await this.persist(batch);
        }
      } catch { /* Invalid metadata is ignored and never executed. */ }
    }
  }

  async create(productId: string, backgroundId: string) {
    if (this.active.size >= MAX_ACTIVE_BATCHES) throw new BatchError('Too many active batches. Wait for a running batch to finish.', 429);
    const [product] = await Promise.all([this.shopify.getProduct(productId, true), this.assets.get('background', backgroundId)]);
    if (product.colors.length > MAX_BATCH_ITEMS) throw new BatchError(`Products with more than ${MAX_BATCH_ITEMS} colors require manual review.`);
    const items = this.reusePreservedSources(productId, this.mapItems(product));
    const now = new Date().toISOString();
    const batch: MockupBatch = { id: crypto.randomUUID(), productId, productTitle: product.title, backgroundId, status: 'running', cancelRequested: false, createdAt: now, updatedAt: now, items, counts: this.counts(items) };
    this.records.set(batch.id, batch);
    await this.persist(batch);
    this.active.add(batch.id);
    void this.process(batch.id).finally(() => this.active.delete(batch.id));
    return batch;
  }

  async get(id: string) {
    this.assertId(id);
    const cached = this.records.get(id);
    if (cached) return cached;
    try { return JSON.parse(await readFile(path.join(this.folder, `${id}.json`), 'utf8')) as MockupBatch; }
    catch { throw new BatchError('Batch not found.', 404); }
  }

  list() { return [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)); }

  async cancel(id: string) {
    const batch = await this.get(id);
    if (batch.status !== 'running') return batch;
    batch.cancelRequested = true; batch.updatedAt = new Date().toISOString(); await this.persist(batch);
    return batch;
  }

  async regenerate(id: string, color: string) {
    const batch = await this.get(id);
    if (this.active.has(id)) throw new BatchError('Wait for the running batch to finish before regenerating a color.', 409);
    const item = batch.items.find((candidate) => candidate.color === color);
    if (!item?.sourceImageId) throw new BatchError('This color has no single reliable source image.', 409);
    item.status = 'queued'; item.reason = undefined; item.preview = undefined;
    batch.status = 'running'; batch.cancelRequested = false; batch.updatedAt = new Date().toISOString(); await this.persist(batch);
    this.active.add(id);
    void this.process(id, color).finally(() => this.active.delete(id));
    return batch;
  }

  async zip(id: string) {
    const batch = await this.get(id);
    const successful = batch.items.filter((item) => item.status === 'success' && item.preview);
    if (successful.length === 0) throw new BatchError('This batch has no generated mockups to download.', 409);
    const entries: Array<{ name: string; data: Buffer }> = [];
    let total = 0;
    for (const item of successful) {
      const bytes = (await this.assets.bytes('preview', item.preview!.id)).buffer;
      total += bytes.length;
      if (total > MAX_ZIP_BYTES) throw new BatchError('Generated mockups exceed the ZIP memory limit.', 413);
      const safeColor = item.color.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'color';
      entries.push({ name: `${safeColor}-${item.preview!.id.slice(0, 8)}.png`, data: bytes });
    }
    return createStoredZip(entries);
  }

  mapItems(product: ShopifyProductDetail): MockupBatchItem[] {
    return product.colors.map((color) => {
      const candidates = product.images.filter((image) => image.association === 'reliable' && image.validation === 'transparent' && image.associatedColors.length === 1 && image.associatedColors[0] === color);
      if (candidates.length === 1) return { color, sourceImageId: candidates[0].id, status: 'queued', attempts: 0 };
      const reason = candidates.length > 1 ? 'Multiple compatible images are reliably associated with this color; choose one manually.' : 'No single compatible transparent image is reliably associated with this color.';
      return { color, status: 'skipped', reason, attempts: 0 };
    });
  }

  private reusePreservedSources(productId: string, items: MockupBatchItem[]) {
    const previous = this.list().filter((batch) => batch.productId === productId);
    for (const item of items) {
      if (item.status !== 'skipped' || !item.reason?.startsWith('No single compatible')) continue;
      const preserved = previous.flatMap((batch) => batch.items).find((candidate) => candidate.color === item.color && candidate.sourceImageId && candidate.sourceAsset?.kind === 'garment');
      if (!preserved?.sourceAsset || !preserved.sourceImageId) continue;
      item.sourceImageId = preserved.sourceImageId; item.sourceAsset = preserved.sourceAsset; item.sourceProvenance = preserved.sourceProvenance;
      item.sourceFreshness = preserved.sourceProvenance
        ? { state: 'historical_unverified', checkedAt: new Date().toISOString(), reason: 'The preserved source is available locally, but Shopify no longer exposes one reliable current source for this color.', currentMediaId: preserved.sourceProvenance.mediaId, comparison: 'not_comparable' }
        : { state: 'provenance_missing', checkedAt: new Date().toISOString(), reason: 'The preserved historical source predates structured provenance.' };
      item.status = 'queued'; item.reason = undefined;
    }
    return items;
  }

  private async process(id: string, onlyColor?: string) {
    let batch = await this.get(id);
    const pending = batch.items.filter((item) => item.status === 'queued' && (!onlyColor || item.color === onlyColor));
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const current = pending[cursor++];
        const latest = await this.get(id);
        if (latest.cancelRequested) { batch.cancelRequested = true; return; }
        const item = batch.items.find((candidate) => candidate.color === current.color)!;
        item.status = 'processing'; item.attempts += 1; await this.update(batch);
        try {
          await this.generateItem(batch, item);
          item.status = 'success'; item.reason = undefined;
        } catch (error) {
          if (!batch.cancelRequested && this.transient(error) && item.attempts < 2) {
            item.status = 'queued'; await this.update(batch); pending.push(item); continue;
          }
          item.status = 'failed'; item.reason = error instanceof Error ? error.message : 'Mockup generation failed.';
        }
        batch.cancelRequested ||= (await this.get(id)).cancelRequested;
        await this.update(batch);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
    batch = await this.get(id);
    if (batch.cancelRequested) for (const item of batch.items) if (item.status === 'queued') { item.status = 'cancelled'; item.reason = 'Cancelled before processing.'; }
    batch.status = batch.cancelRequested ? 'cancelled' : batch.items.some((item) => item.status === 'failed' || item.status === 'skipped') ? 'partial' : 'completed';
    await this.update(batch);
  }

  private async generateItem(batch: MockupBatch, item: MockupBatchItem) {
    if (!item.sourceImageId) throw new BatchError('Source image is missing.');
    const background = await this.assets.bytes('background', batch.backgroundId);
    let garment: Buffer;
    let acquiredSource: ShopifyProductDetail['images'][number] | undefined;
    let currentComparison: 'matches_preserved' | 'source_changed' | 'not_comparable' = 'not_comparable';
    if (item.sourceAsset?.kind === 'garment') {
      garment = (await this.assets.bytes('garment', item.sourceAsset.id)).buffer;
      const localHash = this.hash(garment);
      if (!item.sourceProvenance) item.sourceFreshness = { state: 'provenance_missing', checkedAt: new Date().toISOString(), reason: 'The preserved historical source has no provenance record.' };
      else if (item.sourceProvenance.assetId !== item.sourceAsset.id || item.sourceProvenance.sha256 !== localHash) throw new BatchError('The preserved garment source no longer matches its provenance hash.');
      else item.sourceFreshness = { state: 'historical_unverified', checkedAt: new Date().toISOString(), reason: 'Local bytes match acquisition provenance, but current Shopify artwork cannot be independently verified.', currentMediaId: item.sourceProvenance.mediaId, currentSha256: localHash, comparison: 'not_comparable' };
    }
    else {
      const product = await this.shopify.getProduct(batch.productId, false);
      const source = product.images.find((image) => image.id === item.sourceImageId && image.association === 'reliable' && image.associatedColors.length === 1 && image.associatedColors[0] === item.color);
      if (!source) throw new BatchError('The mapped Shopify source image is no longer available.');
      if (!source.mediaId) throw new BatchError('The mapped Shopify source lacks a stable MediaImage identity.');
      const variants = product.variants.filter((variant) => variant.color === item.color);
      if (!variants.length || variants.some((variant) => !variant.associatedImageIds.includes(source.id) && !variant.associatedImageIds.includes(source.mediaId!))) throw new BatchError('The current Shopify variant-to-color source association changed.');
      try { garment = await this.shopify.downloadImage(source.url); }
      catch (error) {
        item.sourceFreshness = { state: 'source_unavailable', checkedAt: new Date().toISOString(), reason: error instanceof Error ? error.message : 'The current Shopify source could not be downloaded.', currentMediaId: source.mediaId };
        throw error;
      }
      acquiredSource = source;
      const currentHash = this.hash(garment);
      const previous = this.previousProvenance(batch.productId, item.color, batch.id);
      currentComparison = previous ? previous.sha256 === currentHash ? 'matches_preserved' : 'source_changed' : 'not_comparable';
    }
    const inspected = await inspectImage(garment, ['png']);
    if (inspected.format !== 'png' || !(await analyzeTransparency(garment)).isMeaningfullyTransparent) {
      if (acquiredSource) item.sourceFreshness = { state: 'source_unavailable', checkedAt: new Date().toISOString(), reason: 'The current Shopify source is not a meaningful transparent PNG.', currentMediaId: acquiredSource.mediaId };
      throw new BatchError('The mapped source is no longer a compatible transparent PNG.');
    }
    if (acquiredSource) item.sourceFreshness = { state: 'verified_current', checkedAt: new Date().toISOString(), reason: currentComparison === 'source_changed' ? 'The current verified Shopify source differs from the previously preserved source; a new local asset was stored.' : 'The source was downloaded from the uniquely associated current Shopify media.', currentMediaId: acquiredSource.mediaId, currentSha256: this.hash(garment), comparison: currentComparison };
    if (!item.sourceAsset) {
      const acquiredAt = new Date().toISOString();
      if (!acquiredSource?.mediaId) throw new BatchError('The verified Shopify source lacks MediaImage provenance.');
      item.sourceAsset = await this.assets.saveGarment(garment, { originalName: `${batch.productTitle}-${item.color}-source.png`, width: inspected.width, height: inspected.height, hasTransparency: true }, { schemaVersion: 1, productId: batch.productId, color: item.color, mediaId: acquiredSource.mediaId, sourceReference: this.sourceReference(acquiredSource.url), acquiredAt, validatedAt: new Date().toISOString(), width: inspected.width, height: inspected.height, transparency: { meaningful: true } });
      item.sourceProvenance = item.sourceAsset.provenance;
    }
    const output = await this.compositor(background.buffer, garment);
    const meta = await sharp(output).metadata();
    item.preview = await this.assets.save('preview', output, 'png', { originalName: `${batch.productTitle}-${item.color}.png`, width: meta.width!, height: meta.height! });
    item.generationEvidence = { generatedAt: new Date().toISOString(), sourceAssetId: item.sourceAsset.id, sourceSha256: this.hash(garment), backgroundAssetId: batch.backgroundId, backgroundSha256: this.hash(background.buffer), previewAssetId: item.preview.id, previewSha256: this.hash(output) };
  }

  private previousProvenance(productId: string, color: string, excludeBatchId: string): GarmentSourceProvenance | undefined {
    return this.list().filter((batch) => batch.id !== excludeBatchId && batch.productId === productId).flatMap((batch) => batch.items).find((item) => item.color === color && item.sourceProvenance)?.sourceProvenance;
  }
  private hash(buffer: Buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
  private sourceReference(raw: string) { const url = new URL(raw); return `${url.origin}${url.pathname}`; }

  private async update(batch: MockupBatch) { batch.updatedAt = new Date().toISOString(); batch.counts = this.counts(batch.items); await this.persist(batch); }
  private counts(items: MockupBatchItem[]) { return { total: items.length, queued: items.filter((i) => i.status === 'queued').length, processing: items.filter((i) => i.status === 'processing').length, success: items.filter((i) => i.status === 'success').length, failed: items.filter((i) => i.status === 'failed').length, skipped: items.filter((i) => i.status === 'skipped').length, cancelled: items.filter((i) => i.status === 'cancelled').length }; }
  private async persist(batch: MockupBatch) {
    this.records.set(batch.id, batch);
    const snapshot = JSON.stringify(batch, null, 2);
    const previous = this.writes.get(batch.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const destination = path.join(this.folder, `${batch.id}.json`);
      await writeFile(destination, snapshot);
    });
    this.writes.set(batch.id, next);
    try { await next; } finally { if (this.writes.get(batch.id) === next) this.writes.delete(batch.id); }
  }
  private assertId(id: string) { if (!STRICT_UUID.test(id)) throw new BatchError('Batch not found.', 404); }
  private transient(error: unknown) { return error instanceof ShopifyError && error.status >= 500; }
}
