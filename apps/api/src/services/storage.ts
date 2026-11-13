import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AssetKind, GarmentSourceProvenance, ImageAsset } from '@mockup-automation/shared';
import { atomicWriteFile, type AtomicWriter, PersistenceError } from './persistence.js';

type StoredAsset = Omit<ImageAsset, 'url'> & { filename: string };
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AssetStore {
  constructor(private readonly root: string, private readonly writer: AtomicWriter = atomicWriteFile) {}

  private folder(kind: AssetKind) {
    return path.join(this.root, kind === 'preview' ? 'generated' : 'uploads', `${kind}s`);
  }

  async init() {
    await Promise.all(['background', 'garment', 'preview'].map((kind) => mkdir(this.folder(kind as AssetKind), { recursive: true })));
  }

  async save(kind: AssetKind, buffer: Buffer, extension: string, metadata: Omit<StoredAsset, 'id' | 'kind' | 'filename'>) {
    const id = crypto.randomUUID();
    const filename = `${id}.${extension}`;
    await this.writer(path.join(this.folder(kind), filename), buffer);
    const record: StoredAsset = { id, kind, filename, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), ...metadata };
    await this.writer(path.join(this.folder(kind), `${id}.json`), JSON.stringify(record));
    return this.publicAsset(record);
  }

  async saveGarment(buffer: Buffer, metadata: Omit<StoredAsset, 'id' | 'kind' | 'filename' | 'provenance'>, source: Omit<GarmentSourceProvenance, 'assetId' | 'sha256'>) {
    const id = crypto.randomUUID(); const filename = `${id}.png`; const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const provenance: GarmentSourceProvenance = { ...source, assetId: id, sha256 };
    const record: StoredAsset = { id, kind: 'garment', filename, sha256, provenance, ...metadata };
    await this.writer(path.join(this.folder('garment'), filename), buffer);
    await this.writer(path.join(this.folder('garment'), `${id}.json`), JSON.stringify(record));
    return this.publicAsset(record);
  }

  async get(kind: AssetKind, id: string): Promise<StoredAsset> {
    if (!STRICT_UUID.test(id)) throw new Error('Asset not found.');
    try {
      const record = JSON.parse(await readFile(path.join(this.folder(kind), `${id}.json`), 'utf8')) as StoredAsset;
      if (record.id !== id || record.kind !== kind || typeof record.filename !== 'string' || !record.filename.startsWith(`${id}.`)) throw new Error('Invalid asset metadata.');
      return record;
    } catch (error) { throw new PersistenceError(`Asset metadata ${id} is missing, unreadable, or corrupt.`, (error as NodeJS.ErrnoException).code, error); }
  }

  async bytes(kind: AssetKind, id: string) {
    const asset = await this.get(kind, id);
    let buffer: Buffer;
    try { buffer = await readFile(path.join(this.folder(kind), asset.filename)); }
    catch (error) { throw new PersistenceError(`Asset bytes ${id} are missing or unreadable.`, (error as NodeJS.ErrnoException).code, error); }
    if (asset.sha256 && crypto.createHash('sha256').update(buffer).digest('hex') !== asset.sha256) throw new PersistenceError(`Asset bytes ${id} do not match recorded SHA-256 evidence.`, 'HASH_MISMATCH');
    return { asset, buffer };
  }

  publicAsset(asset: StoredAsset): ImageAsset {
    return { ...asset, url: `/api/assets/${asset.kind}/${asset.id}` };
  }
}
