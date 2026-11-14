import { nativeImage } from 'electron';

export const WINDOWS_TRAY_SCALES = [1, 1.25, 1.5, 2, 3] as const;

/** Keep the application artwork intact; only notification states get a badge. */
export function paintWindowsTrayBadge(bitmap: Buffer, size: number): Buffer {
  if (bitmap.length !== size * size * 4) throw new Error('Invalid tray bitmap dimensions');
  const output = Buffer.from(bitmap);
  const center = size * 0.77, radius = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      if (distance > radius) continue;
      const offset = (y * size + x) * 4;
      // A white border keeps the blue badge distinct from the blue brand glyph.
      const blue = distance < radius - Math.max(1, size / 16);
      output[offset] = blue ? 246 : 255;
      output[offset + 1] = blue ? 130 : 255;
      output[offset + 2] = blue ? 59 : 255;
      output[offset + 3] = 255;
    }
  }
  return output;
}

export function createWindowsTrayIcon(iconPath: string, badge: boolean): Electron.NativeImage {
  const artwork = nativeImage.createFromPath(iconPath);
  if (artwork.isEmpty()) throw new Error('Windows tray artwork is empty');
  const result = nativeImage.createEmpty();
  for (const scaleFactor of WINDOWS_TRAY_SCALES) {
    const size = Math.round(16 * scaleFactor);
    const resized = artwork.resize({ width: size, height: size, quality: 'best' });
    const image = badge ? nativeImage.createFromBitmap(paintWindowsTrayBadge(resized.toBitmap(), size), { width: size, height: size }) : resized;
    result.addRepresentation({ scaleFactor, dataURL: image.toDataURL() });
  }
  result.setTemplateImage(false);
  return result;
}
