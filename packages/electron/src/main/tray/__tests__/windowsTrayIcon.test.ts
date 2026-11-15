// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { nativeImage } from 'electron';
vi.mock('electron', () => ({ nativeImage: { createFromPath: vi.fn() } }));
import { createWindowsTrayIcon } from '../windowsTrayIcon';

it.each([false, true])('loads a native ICO path for notification=%s, preserving Windows frame selection', badge => {
  const image = { isEmpty: () => false, setTemplateImage: vi.fn() };
  vi.mocked(nativeImage.createFromPath).mockReturnValue(image as unknown as Electron.NativeImage);
  expect(createWindowsTrayIcon('artwork', badge)).toBe(image);
  expect(nativeImage.createFromPath).toHaveBeenLastCalledWith(expect.stringMatching(badge ? /notification\.ico$/ : /idle\.ico$/));
  expect(image.setTemplateImage).toHaveBeenCalledWith(false);
});

it('rejects missing ICO artwork', () => {
  vi.mocked(nativeImage.createFromPath).mockReturnValue({ isEmpty: () => true } as Electron.NativeImage);
  expect(() => createWindowsTrayIcon('missing', false)).toThrow('missing');
});
