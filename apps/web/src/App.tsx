import { useMemo, useState } from 'react';
import type { ApiError, ImageAsset } from '@mockup-automation/shared';

const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

async function upload(path: string, file: File): Promise<ImageAsset> {
  const body = new FormData(); body.append('image', file);
  const response = await fetch(`${apiBase}${path}`, { method: 'POST', body });
  const result = await response.json() as ImageAsset | ApiError;
  if (!response.ok) throw new Error((result as ApiError).error);
  return result as ImageAsset;
}

function assetUrl(asset?: ImageAsset) { return asset ? `${apiBase}${asset.url}` : ''; }

function UploadCard({ title, hint, accept, endpoint, asset, onAsset }: { title: string; hint: string; accept: string; endpoint: string; asset?: ImageAsset; onAsset: (asset: ImageAsset) => void }) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  async function choose(file?: File) {
    if (!file) return;
    setStatus('Uploading and validating…'); setError('');
    try { onAsset(await upload(endpoint, file)); setStatus('Ready'); }
    catch (cause) { setStatus(''); setError(cause instanceof Error ? cause.message : 'Upload failed.'); }
  }
  return <div className="upload-card">
    <div><h3>{title}</h3><p>{hint}</p></div>
    <label className="upload-button"><input type="file" accept={accept} onChange={(event) => void choose(event.target.files?.[0])}/>{asset ? 'Replace image' : 'Choose file'}</label>
    {status && <span className="status">● {status}</span>}{error && <div className="error" role="alert">{error}</div>}
    {asset && <div className="asset-meta"><strong>{asset.originalName}</strong><span>{asset.width} × {asset.height}px</span></div>}
  </div>;
}

export function App() {
  const [background, setBackground] = useState<ImageAsset>();
  const [garment, setGarment] = useState<ImageAsset>();
  const [preview, setPreview] = useState<ImageAsset>();
  const [message, setMessage] = useState('');
  const [generating, setGenerating] = useState(false);
  const ready = Boolean(background && garment);
  const generatedUrl = useMemo(() => assetUrl(preview), [preview]);

  async function generate() {
    if (!background || !garment) return;
    setGenerating(true); setMessage(''); setPreview(undefined);
    try {
      const response = await fetch(`${apiBase}/api/previews`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backgroundId: background.id, garmentId: garment.id }) });
      const result = await response.json() as ImageAsset | ApiError;
      if (!response.ok) throw new Error((result as ApiError).error);
      setPreview(result as ImageAsset); setMessage('Preview generated. Source images were preserved.');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Preview generation failed.'); }
    finally { setGenerating(false); }
  }

  return <div className="shell">
    <header><div className="brand-mark">EW</div><div><p className="eyebrow">EQUIPD WEAR</p><h1>Mockup Automation</h1></div><span className="phase">Phase 1 · Local</span></header>
    <main>
      <section className="hero"><div><p className="eyebrow">COMPOSITE WORKSPACE</p><h2>Build listing-ready previews without changing the garment.</h2><p>Layer an original transparent apparel PNG over your own background. Every source stays untouched.</p></div><div className="guardrail"><span>✦</span><div><strong>Pixel-preservation rule</strong><p>No AI edits, recoloring, background removal, cropping, or distortion.</p></div></div></section>
      <section className="panel disabled"><div className="section-number">01</div><div className="section-heading"><div><h2>Product Selection</h2><p>Connect and search the Equipd Wear catalog in Phase 2.</p></div><span className="future">Future phase</span></div><div className="search-row"><input disabled placeholder="Shopify product title"/><button disabled>Search Shopify</button></div></section>
      <section className="panel"><div className="section-number">02</div><div className="section-heading"><div><h2>Background Selection</h2><p>Upload one local scene plus an original transparent garment source.</p></div><span className="local">Local files</span></div><div className="upload-grid"><UploadCard title="Background image" hint="JPEG or PNG · up to 12 MB" accept="image/jpeg,image/png" endpoint="/api/backgrounds" asset={background} onAsset={(value) => { setBackground(value); setPreview(undefined); }}/><UploadCard title="Transparent garment" hint="PNG · transparency is verified pixel-by-pixel" accept="image/png" endpoint="/api/garments" asset={garment} onAsset={(value) => { setGarment(value); setPreview(undefined); }}/></div></section>
      <section className="panel"><div className="section-number">03</div><div className="section-heading"><div><h2>Mockup Preview</h2><p>Compare the unchanged source with the generated composite.</p></div><button className="primary" disabled={!ready || generating} onClick={() => void generate()}>{generating ? 'Generating…' : 'Generate Preview'}</button></div><div className="preview-grid"><Preview title="Original garment" src={assetUrl(garment)} empty="Upload a transparent garment PNG" checker/><Preview title="Generated preview" src={generatedUrl} empty={ready ? 'Select Generate Preview' : 'Add both source images'}/></div>{message && <div className={preview ? 'success' : 'error'} role="status">{message}</div>}</section>
      <section className="panel disabled"><div className="section-number">04</div><div className="section-heading"><div><h2>Publishing</h2><p>Shopify writes, variant association, and rollback arrive only after later-phase approval and testing.</p></div><span className="future">Unavailable in Phase 1</span></div><div className="publish-row"><button disabled>Publish to Shopify</button><button disabled>Restore original images</button></div></section>
    </main><footer>Local processing only · Equipd Wear · Source files remain unchanged</footer>
  </div>;
}

function Preview({ title, src, empty, checker = false }: { title: string; src: string; empty: string; checker?: boolean }) {
  return <figure><figcaption>{title}</figcaption><div className={`image-frame ${checker ? 'checker' : ''}`}>{src ? <img src={src} alt={title}/> : <div className="empty"><span>◇</span><p>{empty}</p></div>}</div></figure>;
}
