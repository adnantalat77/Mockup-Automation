import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AssetKind, ImageAsset } from '@mockup-automation/shared';

type StoredAsset = Omit<ImageAsset, 'url'> & { filename: string };

export class AssetStore {
  constructor(private readonly root: string) {}

  private folder(kind: AssetKind) {
    return path.join(this.root, kind === 'preview' ? 'generated' : 'uploads', `${kind}s`);
  }

  async init() {
    await Promise.all(['background', 'garment', 'preview'].map((kind) => mkdir(this.folder(kind as AssetKind), { recursive: true })));
  }

  async save(kind: AssetKind, buffer: Buffer, extension: string, metadata: Omit<StoredAsset, 'id' | 'kind' | 'filename'>) {
    const id = crypto.randomUUID();
    const filename = `${id}.${extension}`;
    await writeFile(path.join(this.folder(kind), filename), buffer, { flag: 'wx' });
    const record: StoredAsset = { id, kind, filename, ...metadata };
    await writeFile(path.join(this.folder(kind), `${id}.json`), JSON.stringify(record), { flag: 'wx' });
    return this.publicAsset(record);
  }

  async get(kind: AssetKind, id: string): Promise<StoredAsset> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Asset not found.');
    try { return JSON.parse(await readFile(path.join(this.folder(kind), `${id}.json`), 'utf8')) as StoredAsset; }
    catch { throw new Error('Asset not found.'); }
  }

  async bytes(kind: AssetKind, id: string) {
    const asset = await this.get(kind, id);
    return { asset, buffer: await readFile(path.join(this.folder(kind), asset.filename)) };
  }

  publicAsset(asset: StoredAsset): ImageAsset {
    return { ...asset, url: `/api/assets/${asset.kind}/${asset.id}` };
  }
}
