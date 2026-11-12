import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import type { AssetKind, GenerateRequest } from '@mockup-automation/shared';
import { AssetStore } from './services/storage.js';
import { analyzeTransparency, compositePreview, ImageValidationError, inspectImage } from './services/images.js';
import { loadConfig, type AppConfig } from './config.js';
import { ShopifyError, ShopifyService } from './services/shopify.js';

export async function createApp(overrides: Partial<AppConfig> = {}) {
  const config = loadConfig(overrides);
  const store = new AssetStore(config.dataDir);
  await store.init();
  let shopify: ShopifyService | undefined;
  let shopifySetupError = config.shopifyConfigurationError;
  if (config.shopify) {
    try { shopify = new ShopifyService(config.shopify, fetch, config.maxUploadBytes); }
    catch (error) { shopifySetupError = error instanceof Error ? error.message : 'Shopify configuration is invalid.'; }
  }
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.webOrigin }));
  app.use(express.json({ limit: '64kb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.get('/api/health', (_request, response) => response.json({ status: 'ok', phase: 2 }));

  app.get('/api/shopify/status', async (_request, response) => {
    if (!shopify) return response.json({ configured: false, connected: false, scopes: [], error: shopifySetupError });
    try { response.json(await shopify.status()); }
    catch (error) { response.status(503).json({ configured: true, connected: false, scopes: [], error: error instanceof Error ? error.message : 'Shopify connectivity failed.' }); }
  });

  app.get('/api/shopify/products', async (request, response, next) => {
    try {
      if (!shopify) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.json(await shopify.searchProducts(String(request.query.title ?? '')));
    } catch (error) { next(error); }
  });

  app.get('/api/shopify/product', async (request, response, next) => {
    try {
      if (!shopify) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.json(await shopify.getProduct(String(request.query.id ?? '')));
    } catch (error) { next(error); }
  });

  app.post('/api/shopify/images/import', async (request, response, next) => {
    try {
      if (!shopify) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      const imported = await shopify.importTransparentImage(String(request.body?.productId ?? ''), String(request.body?.imageId ?? ''));
      const asset = await store.save('garment', imported.buffer, 'png', {
        originalName: imported.originalName, width: imported.info.width, height: imported.info.height, hasTransparency: true
      });
      response.status(201).json(asset);
    } catch (error) { next(error); }
  });

  app.post('/api/backgrounds', upload.single('image'), async (request, response, next) => {
    try {
      if (!request.file) throw new ImageValidationError('Choose a JPEG or PNG background.');
      const info = await inspectImage(request.file.buffer, ['png', 'jpeg']);
      const asset = await store.save('background', request.file.buffer, info.format === 'jpeg' ? 'jpg' : 'png', {
        originalName: request.file.originalname, width: info.width, height: info.height
      });
      response.status(201).json(asset);
    } catch (error) { next(error); }
  });

  app.post('/api/garments', upload.single('image'), async (request, response, next) => {
    try {
      if (!request.file) throw new ImageValidationError('Choose a transparent PNG garment image.');
      const info = await inspectImage(request.file.buffer, ['png']);
      const transparency = await analyzeTransparency(request.file.buffer);
      if (!transparency.isMeaningfullyTransparent) throw new ImageValidationError('This PNG is opaque or contains only insignificant transparent edge pixels. Supply an original garment image with a genuinely transparent background.');
      const asset = await store.save('garment', request.file.buffer, 'png', {
        originalName: request.file.originalname, width: info.width, height: info.height, hasTransparency: true
      });
      response.status(201).json(asset);
    } catch (error) { next(error); }
  });

  app.post('/api/previews', async (request, response, next) => {
    try {
      const { backgroundId, garmentId } = request.body as Partial<GenerateRequest>;
      if (!backgroundId || !garmentId) throw new ImageValidationError('Select both a background and a garment.');
      const [background, garment] = await Promise.all([store.bytes('background', backgroundId), store.bytes('garment', garmentId)]);
      const output = await compositePreview(background.buffer, garment.buffer);
      const meta = await sharp(output).metadata();
      const asset = await store.save('preview', output, 'png', {
        originalName: `preview-${garment.asset.originalName}`, width: meta.width!, height: meta.height!
      });
      response.status(201).json(asset);
    } catch (error) { next(error); }
  });

  app.get('/api/assets/:kind/:id', async (request, response, next) => {
    try {
      const kind = request.params.kind as AssetKind;
      if (!['background', 'garment', 'preview'].includes(kind)) return response.status(404).json({ error: 'Asset not found.' });
      const { asset, buffer } = await store.bytes(kind, request.params.id);
      response.type(asset.filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png').send(buffer);
    } catch (error) { next(error); }
  });

  app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    void _next;
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return response.status(413).json({ error: `Image exceeds the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.` });
    if (error instanceof ShopifyError) return response.status(error.status).json({ error: error.message });
    const clientError = error instanceof ImageValidationError || error?.message === 'Asset not found.';
    response.status(clientError ? 400 : 500).json({ error: clientError ? error.message : 'The request could not be completed.' });
  });
  return app;
}
