import { test, expect, _electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedAgentEnvironment } from './isolatedAgentEnvironment';

test('Windows tray keeps a full-size logo and exact native DPI artwork', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Windows artwork');
  const root = path.resolve(__dirname, '../../..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-tray-artwork-'));
  const helper = path.join(temp, 'tray.cjs'), entry = path.join(temp, 'entry.cjs');
  await build({ entryPoints: [path.join(root, 'packages/electron/src/main/tray/windowsTrayIcon.ts')], outfile: helper, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  await fs.writeFile(entry, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});app.whenReady().then(()=>{global.trayRenderer=require(${JSON.stringify(helper)});global.trayFs=require('node:fs');});`);
  const env = isolatedAgentEnvironment(path.join(temp, 'agent-home'));
  const app = await _electron.launch({ args: [entry], env, timeout: 20000 });
  try {
    const artwork = process.env.NIMBALYST_E2E_APP_PATH
      ? path.join(path.dirname(process.env.NIMBALYST_E2E_APP_PATH), 'resources/tray-windows')
      : path.join(root, 'packages/electron/resources/tray-windows');
    const sheet = info.outputPath('tray-dpi-light-dark.png');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'fixtures/read-windows-tray-icons.ps1'), '-Artwork', artwork, '-Output', temp], { windowsHide: true });
    const metrics = await app.evaluate(async ({ app, nativeImage }, { artwork, sheet, temp }) => {
      await app.whenReady();
      const { createWindowsTrayIcon, WINDOWS_TRAY_SCALES } = (globalThis as any).trayRenderer;
      const fs = (globalThis as any).trayFs;
      const width = 1180, height = 166;
      const canvas = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const shade = y < height / 2 ? 238 : 32, offset = (y * width + x) * 4;
        canvas[offset] = canvas[offset + 1] = canvas[offset + 2] = shade; canvas[offset + 3] = 255;
      }
      const values: Array<{ badge: boolean; scale: number; bytes: number; color: number; visible: number; span: number; exact: boolean }> = [];
      for (const badge of [false, true]) {
        const icon = createWindowsTrayIcon(artwork, badge);
        if (icon.isEmpty()) throw new Error('ICO could not be loaded by Electron');
        for (const [index, scale] of WINDOWS_TRAY_SCALES.entries()) {
          const size = Math.round(16 * scale);
          const bytes = fs.readFileSync(artwork + (badge ? '/notification.ico' : '/idle.ico'));
          let frame: Buffer | undefined;
          for (let entry = 6; entry < 6 + bytes.readUInt16LE(4) * 16; entry += 16) {
            if ((bytes[entry] || 256) === size) frame = bytes.subarray(bytes.readUInt32LE(entry + 12), bytes.readUInt32LE(entry + 12) + bytes.readUInt32LE(entry + 8));
          }
          if (!frame) throw new Error('Missing native ICO frame: ' + size);
          const pixels = nativeImage.createFromPath(temp + '/' + (badge ? 'notification' : 'idle') + '-' + size + '.png').toBitmap();
          let color = 0, visible = 0, left = size, right = 0;
          for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3] > 100) {
            visible++;
            left = Math.min(left, (p / 4) % size); right = Math.max(right, (p / 4) % size);
            if (pixels[p] - pixels[p + 2] > 40) color++;
          }
          const expected = nativeImage.createFromBuffer(frame).toBitmap();
          const exact = pixels.every((value, index) => Math.abs(value - expected[index]) <= 1);
          values.push({ badge, scale, bytes: pixels.length, color, visible, span: right - left + 1, exact });
          for (const top of [8, 83]) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const source = (y * size + x) * 4, dest = ((top + y) * width + index * 144 + (badge ? 76 : 4) + x) * 4;
            if (dest < 0 || dest + 3 >= canvas.length) continue;
            const alpha = pixels[source + 3] / 255;
            for (let channel = 0; channel < 3; channel++) canvas[dest + channel] = Math.round(pixels[source + channel] * alpha + canvas[dest + channel] * (1 - alpha));
          }
        }
      }
      fs.writeFileSync(sheet, nativeImage.createFromBitmap(canvas, { width, height }).toPNG());
      return values;
    }, { artwork, sheet, temp });
    expect(metrics).toHaveLength(16);
    for (const metric of metrics) {
      expect(metric.bytes).toBe(Math.round(16 * metric.scale) ** 2 * 4);
      expect(metric.visible).toBeGreaterThan(8);
      if (metric.badge) expect(metric.color).toBeGreaterThan(0);
      else {
        expect(metric.color).toBe(0);
        expect(metric.span).toBeGreaterThanOrEqual(Math.round(16 * metric.scale) * 0.9);
      }
      expect(metric.exact).toBe(true);
    }
    await info.attach('Light and dark tray artwork', { path: sheet, contentType: 'image/png' });
  } finally { await app.close(); }
});
