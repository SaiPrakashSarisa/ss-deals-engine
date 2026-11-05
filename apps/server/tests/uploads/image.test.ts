import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectImageKind } from '../../src/modules/uploads/magic.js';
import { reencodeImage } from '../../src/modules/uploads/image.js';

describe('reencodeImage', () => {
  it('shrinks the long edge to 1600 pixels and drops metadata', async () => {
    const source = await sharp({
      create: { width: 1800, height: 40, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    const encoded = await reencodeImage(source);
    expect(encoded).toBeDefined();
    if (encoded === undefined) {
      return;
    }
    expect(encoded.mime).toBe('image/jpeg');
    expect(detectImageKind(encoded.bytes)).toBe('image/jpeg');
    const meta = await sharp(encoded.bytes).metadata();
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.width).toBeLessThan(1800);
    expect(meta.exif).toBeUndefined();
  });

  it('does not enlarge a small image and rejects bytes that are not an image', async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const encoded = await reencodeImage(source);
    expect(encoded?.mime).toBe('image/png');
    expect((await sharp(encoded?.bytes).metadata()).width).toBe(8);
    expect(await reencodeImage(Buffer.from('not-an-image'))).toBeUndefined();
  });
});
