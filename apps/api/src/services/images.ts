import sharp from 'sharp';

export class ImageValidationError extends Error {}

export async function inspectImage(buffer: Buffer, allowed: Array<'png' | 'jpeg'>) {
  try {
    const image = sharp(buffer, { failOn: 'error', limitInputPixels: 60_000_000 });
    const metadata = await image.metadata();
    if (!metadata.format || !allowed.includes(metadata.format as 'png' | 'jpeg')) throw new ImageValidationError(`Only ${allowed.join(' or ').toUpperCase()} images are accepted.`);
    if (!metadata.width || !metadata.height) throw new ImageValidationError('The image dimensions could not be read.');
    return { format: metadata.format as 'png' | 'jpeg', width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError('The uploaded file is not a valid supported image.');
  }
}

export async function hasTransparentPixels(buffer: Buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let index = 3; index < data.length; index += info.channels) if (data[index] < 255) return true;
  return false;
}

export async function compositePreview(background: Buffer, garment: Buffer) {
  const backgroundMeta = await sharp(background).metadata();
  if (!backgroundMeta.width || !backgroundMeta.height) throw new ImageValidationError('Background dimensions are unavailable.');
  const overlay = await sharp(garment)
    .resize({ width: backgroundMeta.width, height: backgroundMeta.height, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return sharp(background)
    .rotate()
    .resize(backgroundMeta.width, backgroundMeta.height, { fit: 'fill' })
    .composite([{ input: overlay, gravity: 'center', blend: 'over' }])
    .png({ compressionLevel: 9, quality: 100, adaptiveFiltering: true })
    .toBuffer();
}
