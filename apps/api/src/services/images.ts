import sharp from 'sharp';

export class ImageValidationError extends Error {}

const MIN_SIGNIFICANT_ALPHA = 250;
const MIN_TRANSPARENT_PIXEL_COUNT = 16;
const MIN_TRANSPARENT_FRACTION = 0.001;

export async function inspectImage(buffer: Buffer, allowed: Array<'png' | 'jpeg'>) {
  try {
    const image = sharp(buffer, { failOn: 'error', limitInputPixels: 60_000_000 });
    const metadata = await image.metadata();
    if (!metadata.format || !allowed.includes(metadata.format as 'png' | 'jpeg')) throw new ImageValidationError(`Only ${allowed.join(' or ').toUpperCase()} images are accepted.`);
    if (!metadata.width || !metadata.height) throw new ImageValidationError('The image dimensions could not be read.');
    const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    return {
      format: metadata.format as 'png' | 'jpeg',
      width: swapsAxes ? metadata.height : metadata.width,
      height: swapsAxes ? metadata.width : metadata.height
    };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError('The uploaded file is not a valid supported image.');
  }
}

export interface TransparencyAnalysis {
  isMeaningfullyTransparent: boolean;
  transparentPixels: number;
  requiredPixels: number;
  totalPixels: number;
}

export async function analyzeTransparency(buffer: Buffer): Promise<TransparencyAnalysis> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const totalPixels = info.width * info.height;
  const requiredPixels = Math.min(totalPixels, Math.max(MIN_TRANSPARENT_PIXEL_COUNT, Math.ceil(totalPixels * MIN_TRANSPARENT_FRACTION)));
  let transparentPixels = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    // Count both fully transparent background and antialiased edge pixels, while
    // ignoring a handful of near-opaque pixels caused by encoding artifacts.
    if (data[index] <= MIN_SIGNIFICANT_ALPHA) transparentPixels += 1;
  }
  return { isMeaningfullyTransparent: transparentPixels >= requiredPixels, transparentPixels, requiredPixels, totalPixels };
}

export async function hasTransparentPixels(buffer: Buffer) {
  return (await analyzeTransparency(buffer)).isMeaningfullyTransparent;
}

export async function compositePreview(background: Buffer, garment: Buffer) {
  // Normalize EXIF orientation before reading dimensions. This avoids using the
  // encoded sensor dimensions for portrait JPEGs that are displayed rotated.
  const normalized = await sharp(background).autoOrient().toBuffer({ resolveWithObject: true });
  const { width, height } = normalized.info;
  if (!width || !height) throw new ImageValidationError('Background dimensions are unavailable.');
  const overlay = await sharp(garment)
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return sharp(normalized.data)
    .composite([{ input: overlay, gravity: 'center', blend: 'over' }])
    .png({ compressionLevel: 9, quality: 100, adaptiveFiltering: true })
    .toBuffer();
}
