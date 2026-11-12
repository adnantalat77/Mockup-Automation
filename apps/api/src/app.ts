import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import type { AssetKind, GenerateRequest } from '@mockup-automation/shared';
import { AssetStore } from './services/storage.js';
import { compositePreview, hasTransparentPixels, ImageValidationError, inspectImage } from './services/images.js';
import { loadConfig, type AppConfig } from './config.js';

export async function createApp(overrides: Partial<AppConfig> = {}) {
  const config = loadConfig(overrides);
  const store = new AssetStore(config.dataDir);
  await store.init();
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.webOrigin }));
  app.use(express.json({ limit: '64kb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

  app.get('/api/health', (_request, response) => response.json({ status: 'ok', phase: 1 }));

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
      if (!(await hasTransparentPixels(request.file.buffer))) throw new ImageValidationError('This PNG is fully opaque. Supply an original garment image with transparent pixels.');
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
    const clientError = error instanceof ImageValidationError || error?.message === 'Asset not found.';
    response.status(clientError ? 400 : 500).json({ error: clientError ? error.message : 'The request could not be completed.' });
  });
  return app;
}
