import sharp from 'sharp';
import { detectImageKind, extensionForMime, type ImageMime } from './magic.js';

const MAX_EDGE = 1600;

export type EncodedImage = {
  bytes: Buffer;
  mime: ImageMime;
  extension: 'jpg' | 'png' | 'webp';
};

export async function reencodeImage(bytes: Buffer): Promise<EncodedImage | undefined> {
  const mime = detectImageKind(bytes);
  if (mime === undefined) {
    return undefined;
  }
  try {
    let pipeline = sharp(bytes, { failOn: 'error', animated: false })
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    if (mime === 'image/jpeg') {
      pipeline = pipeline.jpeg({ quality: 85 });
    } else if (mime === 'image/png') {
      pipeline = pipeline.png();
    } else {
      pipeline = pipeline.webp({ quality: 85 });
    }
    const encoded = await pipeline.toBuffer();
    if (detectImageKind(encoded) !== mime) {
      return undefined;
    }
    return { bytes: encoded, mime, extension: extensionForMime(mime) };
  } catch {
    return undefined;
  }
}
