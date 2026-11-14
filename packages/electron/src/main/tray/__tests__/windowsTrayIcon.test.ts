// @vitest-environment node
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ nativeImage: {} }));
import { paintWindowsTrayBadge, WINDOWS_TRAY_SCALES } from '../windowsTrayIcon';

it.each(WINDOWS_TRAY_SCALES)('preserves artwork outside the notification badge at scale %s', scale => {
  const size = Math.round(16 * scale);
  const source = Buffer.alloc(size * size * 4, 77);
  const output = paintWindowsTrayBadge(source, size);
  expect(output).not.toBe(source);
  expect(source.every(value => value === 77)).toBe(true);
  expect(output.subarray(0, Math.floor(size / 2) * size * 4)).toEqual(source.subarray(0, Math.floor(size / 2) * size * 4));
  const center = (Math.floor(size * .77) * size + Math.floor(size * .77)) * 4;
  expect([...output.subarray(center, center + 4)]).toEqual([246, 130, 59, 255]);
});

it('rejects a bitmap with the wrong dimensions instead of corrupting pixels', () => {
  expect(() => paintWindowsTrayBadge(Buffer.alloc(4), 32)).toThrow('dimensions');
});
