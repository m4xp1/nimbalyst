import { nativeImage } from 'electron';
import path from 'node:path';

export const WINDOWS_TRAY_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;

/** Keep the ICO path: Electron then asks Windows for the actual small-icon size. */
export function createWindowsTrayIcon(artworkDirectory: string, badge: boolean): Electron.NativeImage {
  const image = nativeImage.createFromPath(path.join(artworkDirectory, badge ? 'notification.ico' : 'idle.ico'));
  if (image.isEmpty()) throw new Error('Windows tray ICO artwork is missing');
  image.setTemplateImage(false);
  return image;
}
