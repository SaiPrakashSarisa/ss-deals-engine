import { describe, expect, it } from 'vitest';
import { detectImageKind } from '../../src/modules/uploads/magic.js';

describe('detectImageKind', () => {
  it('recognises jpeg, png, and webp from magic bytes', () => {
    expect(detectImageKind(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(
      detectImageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])),
    ).toBe('image/png');
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    expect(detectImageKind(webp)).toBe('image/webp');
  });

  it('rejects a renamed text file and a short buffer', () => {
    expect(detectImageKind(Buffer.from('this is not an image'))).toBeUndefined();
    expect(detectImageKind(Buffer.from([0xff, 0xd8]))).toBeUndefined();
    expect(detectImageKind(Buffer.from('GIF89a'))).toBeUndefined();
  });
});
