import { useEffect, useRef, useState } from 'react';
import type { AbandonReadiness, ApiError, ImageAsset, MockupBatch, PublicationOperation, PublishReadiness, RecoveryReadiness, RollbackFinalizationReadiness, ShopifyProductDetail, ShopifyProductSummary, ShopifyStatus } from '@mockup-automation/shared';
import { validateAndRefreshHistory } from './publishing-state.js';

// Development stays same-origin through Vite's /api proxy. A production host
// can provide VITE_API_URL when the deployed API has a separate origin.
const apiBase = import.meta.env.PROD ? (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '') : '';
const abandonmentTestProductId = 'gid://shopify/Product/15608846975264';

async function upload(path: string, file: File): Promise<ImageAsset> {
  const body = new FormData(); body.append('image', file);
  const response = await fetch(`${apiBase}${path}`, { method: 'POST', body });
  const result = await response.json() as ImageAsset | ApiError;
  if (!response.ok) throw new Error((result as ApiError).error);
  return result as ImageAsset;
}

function assetUrl(asset?: ImageAsset) { return asset ? `${apiBase}${asset.url}` : ''; }

function publicationStage(operation: PublicationOperation) {
  if (operation.status === 'published') return 'Verified';
  if (operation.status !== 'publishing') return undefined;
  if (operation.items.some((item) => !item.createdMediaId)) return 'Uploading generated images';
  if (operation.items.some((item) => !operation.completedSteps.includes(`variants:${item.color}`))) return 'Associating variants';
  if (operation.publicationMode === 'replace_gallery' && operation.originalMediaOrder.some((id) => !operation.completedSteps.includes(`removed-original:${id}`))) return 'Replacing product gallery';
  if (!operation.completedSteps.includes('published-order')) return 'Ordering generated gallery';
  return 'Verifying final Shopify state';
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  const result = await response.json() as T | ApiError;
  if (!response.ok) throw new Error((result as ApiError).error);
  return result as T;
}

function UploadCard({ title, hint, accept, endpoint, asset, onAsset }: { title: string; hint: string; accept: string; endpoint: string; asset?: ImageAsset; onAsset: (asset: ImageAsset) => void }) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const requestNumber = useRef(0);
  async function choose(file?: File) {
    if (!file) return;
    const currentRequest = ++requestNumber.current;
    setUploading(true);
    setStatus('Uploading and validating…'); setError('');
    try {
      const uploaded = await upload(endpoint, file);
      if (currentRequest !== requestNumber.current) return;
      onAsset(uploaded); setStatus('Ready');
    } catch (cause) {
      if (currentRequest !== requestNumber.current) return;
      setStatus(asset ? `Current selection retained: ${asset.originalName}` : 'No image selected');
      setError(`Upload failed. ${cause instanceof Error ? cause.message : 'The file could not be uploaded.'}`);
    } finally {
      if (currentRequest === requestNumber.current) setUploading(false);
    }
  }
  return <div className="upload-card">
    <div><h3>{title}</h3><p>{hint}</p></div>
    <label className="upload-button"><input type="file" accept={accept} disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file); }}/>{uploading ? 'Validating…' : asset ? 'Replace image' : 'Choose file'}</label>
    {status && <span className="status">● {status}</span>}{error && <div className="error" role="alert">{error}</div>}
    {asset && <div className="asset-meta"><strong>{asset.originalName}</strong><span>{asset.width} × {asset.height}px</span></div>}
  </div>;
}

function ShopifyProductPanel({ onProduct }: { onProduct: (product: ShopifyProductDetail) => void }) {
  const [status, setStatus] = useState<ShopifyStatus>({ configured: false, connected: false, scopes: [] });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ShopifyProductSummary[]>([]);
  const [product, setProduct] = useState<ShopifyProductDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [importedSource, setImportedSource] = useState<ImageAsset>();

  useEffect(() => {
    void apiJson<ShopifyStatus>('/api/shopify/status')
      .then(setStatus)
      .catch((cause) => setStatus({ configured: true, connected: false, scopes: [], error: cause instanceof Error ? cause.message : 'Shopify connectivity failed.' }));
  }, []);

  async function search() {
    setBusy(true); setError(''); setProduct(undefined);
    try { setResults(await apiJson<ShopifyProductSummary[]>(`/api/shopify/products?title=${encodeURIComponent(query)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Product search failed.'); }
    finally { setBusy(false); }
  }

  async function select(id: string) {
    setBusy(true); setError(''); setImportedSource(undefined);
    try { const selected = await apiJson<ShopifyProductDetail>(`/api/shopify/product?id=${encodeURIComponent(id)}`); setProduct(selected); onProduct(selected); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Product details could not be loaded.'); }
    finally { setBusy(false); }
  }

  async function useImage(imageId: string) {
    if (!product) return;
    setBusy(true); setError('');
    try {
      const asset = await apiJson<ImageAsset>('/api/shopify/images/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: product.id, imageId }) });
      setImportedSource(asset);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Shopify image import failed.'); }
    finally { setBusy(false); }
  }

  const label = status.connected ? `Connected · ${status.shop}` : status.configured ? 'Connection unavailable' : 'Not configured';
  return <section className={`panel ${status.connected ? '' : 'disabled'}`}>
    <div className="section-number">01</div>
    <div className="section-heading"><div><h2>Shopify Product Selection</h2><p>Read-only Shopify catalog lookup. No product data can be changed.</p></div><span className={status.connected ? 'local' : 'future'}>{label}</span></div>
    {!status.connected && <div className="notice">{status.error ?? 'Add optional Shopify server credentials to enable product search and bulk generation.'}</div>}
    <form className="search-row" onSubmit={(event) => { event.preventDefault(); void search(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} disabled={!status.connected || busy} placeholder="Exact Shopify product title"/><button disabled={!status.connected || busy || query.trim().length < 2}>{busy ? 'Loading…' : 'Search Shopify'}</button></form>
    {error && <div className="error" role="alert">{error}</div>}
    {results.length > 0 && <div className="product-results">{results.map((result) => <button type="button" className="product-result" key={result.id} onClick={() => void select(result.id)} disabled={busy}>{result.imageUrl ? <img src={result.imageUrl} alt=""/> : <span className="result-placeholder">◇</span>}<span><strong>{result.title}</strong><small>{result.status} · {result.handle}</small></span></button>)}</div>}
    {product && <div className="product-detail"><div className="product-summary"><div><span className="eyebrow">SELECTED PRODUCT</span><h3>{product.title}</h3></div><div><strong>{product.colors.length}</strong><small> colors</small> · <strong>{product.variants.length}</strong><small> variants</small></div></div>
      <div className="chips">{product.colors.map((color) => <span key={color}>{color}</span>)}{product.colors.length === 0 && <span>Color option not identified</span>}</div>
      <h4>Product images</h4>{importedSource && <div className="success" role="status">Imported locally: {importedSource.originalName}. The Shopify original was not changed.</div>}<div className="shopify-images">{product.images.map((image) => <article key={image.id} className="shopify-image"><div className="shopify-image-frame"><img src={image.url} alt={image.altText ?? 'Shopify product image'}/></div><div><span className={`validation ${image.validation}`}>{image.validation}</span><p>{image.association === 'reliable' ? `Associated: ${image.associatedColors.join(', ')}` : image.association === 'ambiguous' ? 'Manual review: shared across colors' : 'Manual review: no reliable color association'}</p><button type="button" disabled={busy || image.validation !== 'transparent'} onClick={() => void useImage(image.id)}>Import transparent source</button></div></article>)}</div>
    </div>}
  </section>;
}

function BatchPanel({ product, background, onBatch }: { product?: ShopifyProductDetail; background?: ImageAsset; onBatch: (batch: MockupBatch) => void }) {
  const [batch, setBatch] = useState<MockupBatch>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (batch) onBatch(batch); }, [batch, onBatch]);

  useEffect(() => {
    void apiJson<MockupBatch[]>('/api/batches').then((saved) => { if (saved[0]) setBatch(saved[0]); }).catch(() => { /* Shopify can be intentionally unconfigured. */ });
  }, []);

  useEffect(() => {
    if (!batch || batch.status !== 'running') return;
    const timer = window.setInterval(() => {
      void apiJson<MockupBatch>(`/api/batches/${batch.id}`).then(setBatch).catch((cause) => setError(cause instanceof Error ? cause.message : 'Batch status failed.'));
    }, 750);
    return () => window.clearInterval(timer);
  }, [batch?.id, batch?.status]);

  async function createBatch() {
    if (!product || !background) return;
    setBusy(true); setError('');
    try { setBatch(await apiJson<MockupBatch>('/api/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: product.id, backgroundId: background.id }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Batch generation could not start.'); }
    finally { setBusy(false); }
  }

  async function cancel() { if (batch) setBatch(await apiJson<MockupBatch>(`/api/batches/${batch.id}/cancel`, { method: 'POST' })); }
  async function regenerate(color: string) { if (batch) setBatch(await apiJson<MockupBatch>(`/api/batches/${batch.id}/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }) })); }

  return <section className="panel"><div className="section-number">03</div><div className="section-heading"><div><h2>Bulk Mockup Generation</h2><p>Generate one preview for every color with exactly one reliable transparent source.</p></div><button className="primary" disabled={!product || !background || busy || batch?.status === 'running'} onClick={() => void createBatch()}>{busy ? 'Preparing…' : 'Generate All Mockups'}</button></div>
    {!product || !background ? <div className="notice">Select a Shopify product and upload a background to enable batch generation.</div> : null}
    {error && <div className="error">{error}</div>}
    {batch && <div className="batch-workspace"><div className="batch-status"><strong>{batch.status}</strong><span>{batch.counts.success} succeeded</span><span>{batch.counts.failed} failed</span><span>{batch.counts.skipped} skipped</span><span>{batch.counts.processing + batch.counts.queued} remaining</span>{batch.status === 'running' && <button onClick={() => void cancel()}>Cancel safely</button>}{batch.counts.success > 0 && <a className="download-button" href={`${apiBase}/api/batches/${batch.id}/download`}>Download ZIP</a>}</div>
      <div className="batch-progress"><span style={{ width: `${batch.counts.total ? ((batch.counts.success + batch.counts.failed + batch.counts.skipped + batch.counts.cancelled) / batch.counts.total) * 100 : 0}%` }}/></div>
      <div className="batch-gallery">{batch.items.map((item) => <article className="batch-card" key={item.color}><div className="batch-image">{item.preview ? <img src={assetUrl(item.preview)} alt={`${item.color} generated mockup`}/> : <span aria-hidden="true">◇</span>}</div><div><h3>{item.color}</h3><span className={`validation ${item.status === 'success' ? 'transparent' : item.status === 'skipped' ? 'opaque' : 'unavailable'}`}>{item.status}</span>{item.reason && <p>{item.reason}</p>}{item.sourceImageId && batch.status !== 'running' && <button onClick={() => void regenerate(item.color)}>Regenerate</button>}</div></article>)}</div>
    </div>}
  </section>;
}

function PublishingPanel({ batch, product }: { batch?: MockupBatch; product?: ShopifyProductDetail }) {
  const [status, setStatus] = useState<{ enabled: boolean; reason?: string }>({ enabled: false });
  const [authorization, setAuthorization] = useState('');
  const [readiness, setReadiness] = useState<PublishReadiness>();
  const [history, setHistory] = useState<PublicationOperation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [abandonReview, setAbandonReview] = useState<{ operation: PublicationOperation; readiness: AbandonReadiness }>();
  const [recoveryReview, setRecoveryReview] = useState<{ operation: PublicationOperation; readiness: RecoveryReadiness }>();
  const [finalizationReview, setFinalizationReview] = useState<{ operation: PublicationOperation; readiness: RollbackFinalizationReadiness }>();

  useEffect(() => { void apiJson<{ enabled: boolean; reason?: string }>('/api/publishing/status').then(setStatus); }, []);
  const authorized = (path: string, init: RequestInit = {}) => apiJson<any>(path, { ...init, headers: { 'Content-Type': 'application/json', 'X-Publish-Authorization': authorization, ...(init.headers ?? {}) } });
  async function refreshHistory() { if (authorization) setHistory(await authorized('/api/publishing/operations')); }
  async function refreshHistorySafely() { try { await refreshHistory(); setHistoryError(''); } catch (cause) { setHistoryError(cause instanceof Error ? cause.message : 'Publication history could not be refreshed.'); } }
  async function validate() {
    if (!batch) return; setBusy(true); setError(''); setHistoryError('');
    try {
      const result = await validateAndRefreshHistory(
        () => authorized('/api/publishing/validate', { method: 'POST', body: JSON.stringify({ batchId: batch.id }) }),
        () => authorized('/api/publishing/operations')
      );
      setReadiness(result.readiness); if (result.history) setHistory(result.history); setHistoryError(result.historyError ?? '');
    } catch (cause) { setReadiness(undefined); setError(cause instanceof Error ? cause.message : 'Validation failed.'); }
    finally { setBusy(false); }
  }
  async function publish() {
    if (!batch || !readiness?.ready) return;
    const warning = `Replace the current ${readiness.currentGalleryImageCount}-image gallery with ${readiness.expectedFinalGalleryImageCount} generated images and update ${readiness.variantCount} variants.`;
    if (readiness.confirmationText === 'PUBLISH') { if (!window.confirm(warning)) return; }
    else if (window.prompt(`${warning}\nType exactly: ${readiness.confirmationText}`) !== readiness.confirmationText) return;
    setBusy(true); setError('');
    const timer = window.setInterval(() => void refreshHistorySafely(), 750);
    try { await authorized('/api/publishing/publish', { method: 'POST', body: JSON.stringify({ batchId: batch.id, confirm: readiness.confirmationText }) }); await refreshHistorySafely(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Publication failed.'); }
    finally { window.clearInterval(timer); setBusy(false); }
  }
  async function rollback(operation: PublicationOperation) {
    if (!window.confirm('Restore original variant associations and remove only media created by this operation?')) return;
    setBusy(true); setError(''); try { await authorized(`/api/publishing/${operation.id}/rollback`, { method: 'POST', body: JSON.stringify({ confirm: 'ROLLBACK' }) }); await refreshHistorySafely(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Rollback failed.'); } finally { setBusy(false); }
  }
  async function verifyRollbackFinalization(operation: PublicationOperation) {
    setBusy(true); setError(''); setFinalizationReview(undefined);
    try {
      const result = await authorized(`/api/publishing/${operation.id}/rollback-finalization/validate`, { method: 'POST', body: '{}' });
      setFinalizationReview({ operation, readiness: result });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Rollback finalization verification failed.'); }
    finally { setBusy(false); }
  }
  async function finalizeRestoredProduct() {
    if (!finalizationReview?.readiness.eligible) return;
    const { operation } = finalizationReview; const expected = `FINALIZE ${operation.id} FILES RETAINED`;
    const confirmation = window.prompt(`The Shopify product is restored, but ${finalizationReview.readiness.retainedFileCount} generated files will remain in Content → Files. Type exactly: ${expected}`);
    if (confirmation !== expected) return;
    setBusy(true); setError('');
    try {
      await authorized(`/api/publishing/${operation.id}/rollback-finalization`, { method: 'POST', body: JSON.stringify({ confirm: expected }) });
      setFinalizationReview(undefined); await refreshHistorySafely();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Rollback finalization failed.'); }
    finally { setBusy(false); }
  }
  async function verifyRecovery(operation: PublicationOperation) {
    setBusy(true); setError(''); setRecoveryReview(undefined);
    try {
      const recovery = await authorized(`/api/publishing/${operation.id}/recovery/validate`, { method: 'POST', body: JSON.stringify({ batchId: operation.batchId }) });
      setRecoveryReview({ operation, readiness: recovery });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Recovery verification failed.'); }
    finally { setBusy(false); }
  }
  async function resumeSelected() {
    if (!recoveryReview?.readiness.eligible) return;
    const { operation } = recoveryReview; const expected = `RESUME ${operation.id}`;
    if (!window.confirm(`Resume publication operation ${operation.id}? Live Shopify state will be reconciled again before any remaining step.`)) return;
    setBusy(true); setError('');
    try {
      await authorized(`/api/publishing/${operation.id}/resume`, { method: 'POST', body: JSON.stringify({ batchId: operation.batchId, confirm: expected }) });
      setRecoveryReview(undefined); await refreshHistorySafely();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Publication recovery failed.'); }
    finally { setBusy(false); }
  }
  async function verifyAbandonment(operation: PublicationOperation) {
    setBusy(true); setError(''); setAbandonReview(undefined);
    try {
      const readiness = await authorized(`/api/publishing/${operation.id}/abandon/validate`, { method: 'POST', body: '{}' });
      setAbandonReview({ operation, readiness });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Abandonment verification failed.'); }
    finally { setBusy(false); }
  }
  async function abandonSelected() {
    if (!abandonReview?.readiness.eligible) return;
    const { operation } = abandonReview; const expected = `ABANDON ${operation.id}`;
    const confirmation = window.prompt(`Type exactly: ${expected}`); if (confirmation !== expected) return;
    const reason = window.prompt('Reason for abandoning this disposable test operation:'); if (!reason || reason.trim().length < 10) { setError('Provide an abandonment reason of at least 10 characters.'); return; }
    setBusy(true); setError('');
    try {
      await authorized(`/api/publishing/${operation.id}/abandon`, { method: 'POST', body: JSON.stringify({ confirm: expected, reason }) });
      setAbandonReview(undefined); await refreshHistorySafely();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Abandonment failed.'); }
    finally { setBusy(false); }
  }
  return <section className={`panel ${status.enabled ? '' : 'disabled'}`}><div className="section-number">04</div><div className="section-heading"><div><h2>Publishing and Rollback</h2><p>Explicitly validate, approve, publish, and restore a completed batch.</p></div><span className={status.enabled ? 'local' : 'future'}>{status.enabled ? 'Server enabled' : 'Disabled by default'}</span></div>
    {!status.enabled && <div className="notice">{status.reason ?? 'Publishing is disabled.'}</div>}
    <div className="publish-auth"><input type="password" autoComplete="off" placeholder="Local publishing authorization" value={authorization} onChange={(event) => setAuthorization(event.target.value)} disabled={!status.enabled}/><button disabled={!status.enabled || !authorization || busy} onClick={() => void refreshHistorySafely()}>Load publication history</button><button disabled={!status.enabled || !authorization || !batch || busy} onClick={() => void validate()}>Validate new publication</button></div>
    {error && <div className="error">{error}</div>}
    {historyError && <div className="notice" role="status">Publication history could not be refreshed: {historyError}</div>}
    {finalizationReview && <div className={finalizationReview.readiness.eligible ? 'notice' : 'error'}><strong>Rollback finalization verification: {finalizationReview.operation.id}</strong>{finalizationReview.readiness.eligible ? <><p>The original product media order and variant associations match the immutable snapshot. {finalizationReview.readiness.retainedFileCount} generated files remain globally because deletion ownership could not be proven.</p><button className="primary" disabled={busy} onClick={() => void finalizeRestoredProduct()}>Finalize Restored Product</button></> : <p>{finalizationReview.readiness.errors.join(' ')}</p>}</div>}
    {recoveryReview && <div className={recoveryReview.readiness.eligible ? 'notice' : 'error'}><strong>Recovery verification: {recoveryReview.operation.id}</strong>{recoveryReview.readiness.eligible ? <><p>{recoveryReview.readiness.imageCount} image records and {recoveryReview.readiness.variantCount} variant mappings are consistent with the immutable operation. Original media IDs and associations remain recorded for rollback.</p><button className="primary" disabled={busy} onClick={() => void resumeSelected()}>Resume Publication</button></> : <p>{recoveryReview.readiness.errors.join(' ')}</p>}</div>}
    {abandonReview && <div className={abandonReview.readiness.eligible ? 'notice' : 'error'}><strong>Abandonment verification: {abandonReview.operation.id}</strong>{abandonReview.readiness.eligible ? <><p>Live product media order and all original variant associations match the immutable snapshot. No generated media from this operation remains attached.</p><button disabled={busy} onClick={() => void abandonSelected()}>Abandon Partial Operation</button></> : <p>{abandonReview.readiness.errors.join(' ')}</p>}</div>}
    {readiness && <div className={readiness.ready ? 'success' : 'error'}>{readiness.ready ? `${readiness.imageCount} color images will replace ${readiness.currentGalleryImageCount} existing gallery images and map ${readiness.variantCount} variants. Final gallery: ${readiness.expectedFinalGalleryImageCount} images.` : readiness.errors.join(' ')}</div>}
    {readiness?.ready && batch && <><div className="notice"><strong>Gallery replacement:</strong> all current product gallery references will be removed after generated images and variant mappings are verified. Original Shopify Files are retained for rollback.</div><div className="publish-review">{readiness.colors.map((entry) => { const item = batch.items.find((candidate) => candidate.color === entry.color); const before = product?.images.find((image) => image.id === item?.sourceImageId); return <article key={entry.color}><h3>{entry.color}</h3><div><figure><figcaption>Before</figcaption>{before ? <img src={before.url} alt="Original Shopify source"/> : <span>Unavailable</span>}</figure><figure><figcaption>After</figcaption>{item?.preview ? <img src={assetUrl(item.preview)} alt="Generated preview"/> : <span>Unavailable</span>}</figure></div><p>{entry.variantCount} variants will use this image</p></article>; })}</div><button className="primary" disabled={busy} onClick={() => void publish()}>{busy ? 'Operation in progress…' : 'Replace Gallery and Publish'}</button></>}
    {history.length > 0 && <div className="publication-history"><h3>Publication history</h3>{history.map((operation) => <article key={operation.id}><div><strong>{operation.productTitle}</strong><span>{operation.status === 'rolled_back_files_retained' ? 'Restored — Files Retained' : operation.status}</span>{publicationStage(operation) && <small>{publicationStage(operation)}</small>}<small>{new Date(operation.updatedAt).toLocaleString()}</small></div><div>{operation.items.map((item) => <span key={item.color}>{item.color}: {item.status}</span>)}</div>{operation.status === 'partial' && <button disabled={busy} onClick={() => void verifyRecovery(operation)}>Check Recovery</button>}{operation.status === 'conflict' && operation.productRestored === true && operation.items.every((item) => item.status === 'rolled_back' && item.cleanupPending) && <button disabled={busy} onClick={() => void verifyRollbackFinalization(operation)}>Check Rollback Finalization</button>}{['published','partial','rollback_partial','conflict'].includes(operation.status) && operation.productRestored !== true && <button disabled={busy} onClick={() => void rollback(operation)}>Restore Original Images</button>}{operation.productId === abandonmentTestProductId && ['partial','rollback_partial','conflict'].includes(operation.status) && operation.productRestored !== true && <button disabled={busy} onClick={() => void verifyAbandonment(operation)}>Verify for Abandonment</button>}{operation.status === 'rolled_back_files_retained' && <small>{operation.rollbackFinalizationEvidence?.retainedGeneratedMediaIds.length ?? 0} generated files retained in Shopify Content → Files.</small>}{operation.status === 'abandoned' && <small>Abandoned {operation.abandonedAt ? new Date(operation.abandonedAt).toLocaleString() : ''}: {operation.abandonmentReason}</small>}</article>)}</div>}
  </section>;
}

export function App() {
  const [background, setBackground] = useState<ImageAsset>();
  const [selectedProduct, setSelectedProduct] = useState<ShopifyProductDetail>();
  const [latestBatch, setLatestBatch] = useState<MockupBatch>();

  return <div className="shell">
    <header><div className="brand-mark">EW</div><div><p className="eyebrow">EQUIPD WEAR</p><h1>Mockup Automation</h1></div><span className="phase">Phase 4 · Guarded publishing</span></header>
    <main>
      <section className="hero"><div><p className="eyebrow">COMPOSITE WORKSPACE</p><h2>Build listing-ready previews without changing the garment.</h2><p>Combine reliably mapped Shopify garment sources with your selected background. Every source stays untouched.</p></div><div className="guardrail"><span>✦</span><div><strong>Pixel-preservation rule</strong><p>No AI edits, recoloring, background removal, cropping, or distortion.</p></div></div></section>
      <ShopifyProductPanel onProduct={setSelectedProduct}/>
      <section className="panel"><div className="section-number">02</div><div className="section-heading"><div><h2>Background Selection</h2><p>Upload the local JPEG or PNG scene used for bulk mockup generation.</p></div><span className="local">Local file</span></div><div className="upload-grid"><UploadCard title="Background image" hint="JPEG or PNG · up to 12 MB" accept="image/jpeg,image/png" endpoint="/api/backgrounds" asset={background} onAsset={setBackground}/></div></section>
      <BatchPanel product={selectedProduct} background={background} onBatch={setLatestBatch}/>
      <PublishingPanel batch={latestBatch} product={selectedProduct}/>
    </main><footer>Local processing only · Equipd Wear · Source files remain unchanged</footer>
  </div>;
}
