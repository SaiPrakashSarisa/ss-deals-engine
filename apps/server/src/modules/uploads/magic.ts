export const imageMimes = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type ImageMime = (typeof imageMimes)[number];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function detectImageKind(bytes: Uint8Array): ImageMime | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= PNG.length && PNG.every((byte, index) => bytes[index] === byte)) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

export function extensionForMime(mime: ImageMime): 'jpg' | 'png' | 'webp' {
  if (mime === 'image/jpeg') {
    return 'jpg';
  }
  if (mime === 'image/png') {
    return 'png';
  }
  return 'webp';
}
