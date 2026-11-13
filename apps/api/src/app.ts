import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import type { AssetKind, GenerateRequest } from '@mockup-automation/shared';
import { AssetStore } from './services/storage.js';
import { analyzeTransparency, compositePreview, ImageValidationError, inspectImage } from './services/images.js';
import { loadConfig, type AppConfig } from './config.js';
import { ShopifyError, ShopifyService } from './services/shopify.js';
import { BatchError, BatchService } from './services/batches.js';
import { PublicationError, PublishingService } from './services/publishing.js';

export function isPublishingOriginAllowed(origin: string | undefined, configuredOrigin: string, requireOrigin: boolean) {
  if (!origin) return !requireOrigin;
  return new Set([configuredOrigin, 'http://127.0.0.1:3000', 'http://localhost:3000']).has(origin);
}

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
  const batches = shopify ? new BatchService(config.dataDir, store, shopify) : undefined;
  if (batches) await batches.init();
  const publishing = shopify && batches ? new PublishingService(config.dataDir, store, batches, shopify) : undefined;
  if (publishing) await publishing.init();
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.webOrigin }));
  app.use(express.json({ limit: '64kb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.get('/api/health', (_request, response) => response.json({ status: 'ok', phase: 4 }));

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

  app.post('/api/batches', async (request, response, next) => {
    try {
      if (!batches) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.status(202).json(await batches.create(String(request.body?.productId ?? ''), String(request.body?.backgroundId ?? '')));
    } catch (error) { next(error); }
  });

  app.get('/api/batches', (_request, response, next) => {
    try {
      if (!batches) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.json(batches.list());
    } catch (error) { next(error); }
  });

  app.get('/api/batches/:id', async (request, response, next) => {
    try {
      if (!batches) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.json(await batches.get(request.params.id));
    } catch (error) { next(error); }
  });

  app.post('/api/batches/:id/cancel', async (request, response, next) => {
    try {
      if (!batches) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.json(await batches.cancel(request.params.id));
    } catch (error) { next(error); }
  });

  app.post('/api/batches/:id/regenerate', async (request, response, next) => {
    try {
      if (!batches) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      response.status(202).json(await batches.regenerate(request.params.id, String(request.body?.color ?? '')));
    } catch (error) { next(error); }
  });

  app.get('/api/batches/:id/download', async (request, response, next) => {
    try {
      if (!batches) throw new ShopifyError('Shopify is not configured.', 503, 'NOT_CONFIGURED');
      const archive = await batches.zip(request.params.id);
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename="mockups-${request.params.id}.zip"`);
      response.send(archive);
    } catch (error) { next(error); }
  });

  const requiredPublishingScopes = ['read_products', 'write_products', 'write_files'];

  const verifyPublishingScopes = async () => {
    if (!shopify) throw new PublicationError('Shopify is not configured.', 503);
    const status = await shopify.status();
    const missing = requiredPublishingScopes.filter((scope) => !status.scopes.includes(scope));
    if (missing.length) throw new PublicationError(`Shopify is missing required publishing scopes: ${missing.join(', ')}.`, 403);
  };

  app.get('/api/publishing/status', async (_request, response) => {
    if (!config.publishingEnabled) return response.json({ enabled: false, reason: 'Publishing is disabled by the server feature flag.' });
    if (!publishing) return response.json({ enabled: false, reason: 'Shopify is not configured.' });
    if (!config.publishingAuthToken || config.publishingAuthToken.length < 32) return response.json({ enabled: false, reason: 'Publishing authorization is not configured securely.' });
    try { await verifyPublishingScopes(); return response.json({ enabled: true }); }
    catch (error) { return response.json({ enabled: false, reason: error instanceof Error ? error.message : 'Publishing scope verification failed.' }); }
  });

  const authorizePublishing = (request: express.Request, requireOrigin = true) => {
    if (!config.publishingEnabled) throw new PublicationError('Shopify publishing is disabled by the server.', 403);
    if (!publishing || !config.publishingAuthToken || config.publishingAuthToken.length < 32) throw new PublicationError('Shopify publishing is not configured securely.', 403);
    const origin = request.get('origin');
    if (!isPublishingOriginAllowed(origin, config.webOrigin, requireOrigin)) throw new PublicationError('Publishing request origin was rejected.', 403);
    const supplied = request.get('x-publish-authorization') ?? '';
    const expected = Buffer.from(config.publishingAuthToken); const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new PublicationError('Publishing authorization failed.', 401);
  };

  app.post('/api/publishing/validate', async (request, response, next) => {
    try { authorizePublishing(request); await verifyPublishingScopes(); response.json(await publishing!.validate(String(request.body?.batchId ?? ''))); }
    catch (error) { next(error); }
  });

  app.post('/api/publishing/publish', async (request, response, next) => {
    try {
      authorizePublishing(request);
      await verifyPublishingScopes();
      if (request.body?.confirm !== 'PUBLISH') throw new PublicationError('Explicit publish confirmation is required.', 400);
      response.json(await publishing!.publish(String(request.body?.batchId ?? '')));
    } catch (error) { next(error); }
  });

  app.get('/api/publishing/operations', async (request, response, next) => {
    try { authorizePublishing(request, false); await verifyPublishingScopes(); response.json(publishing!.list()); }
    catch (error) { next(error); }
  });

  app.post('/api/publishing/:id/abandon/validate', async (request, response, next) => {
    try { authorizePublishing(request); await verifyPublishingScopes(); response.json(await publishing!.validateAbandonment(request.params.id)); }
    catch (error) { next(error); }
  });

  app.post('/api/publishing/:id/abandon', async (request, response, next) => {
    try {
      authorizePublishing(request); await verifyPublishingScopes();
      if (request.body?.confirm !== `ABANDON ${request.params.id}`) throw new PublicationError('Explicit abandonment confirmation with the operation ID is required.', 400);
      response.json(await publishing!.abandon(request.params.id, String(request.body?.reason ?? '')));
    } catch (error) { next(error); }
  });

  app.post('/api/publishing/:id/rollback', async (request, response, next) => {
    try {
      authorizePublishing(request);
      await verifyPublishingScopes();
      if (request.body?.confirm !== 'ROLLBACK') throw new PublicationError('Explicit rollback confirmation is required.', 400);
      response.json(await publishing!.rollback(request.params.id));
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
    if (error instanceof BatchError) return response.status(error.status).json({ error: error.message });
    if (error instanceof PublicationError) return response.status(error.status).json({ error: error.message });
    const clientError = error instanceof ImageValidationError || error?.message === 'Asset not found.';
    response.status(clientError ? 400 : 500).json({ error: clientError ? error.message : 'The request could not be completed.' });
  });
  return app;
}
