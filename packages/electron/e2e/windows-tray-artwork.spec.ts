import { test, expect, _electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isolatedAgentEnvironment } from './isolatedAgentEnvironment';

test('Windows tray artwork retains color and DPI representations', async ({}, info) => {
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
      ? path.join(path.dirname(process.env.NIMBALYST_E2E_APP_PATH), 'resources/app.asar/icon.png')
      : path.join(root, 'packages/electron/icon.png');
    const sheet = info.outputPath('tray-dpi-light-dark.png');
    const metrics = await app.evaluate(async ({ app, nativeImage }, { artwork, sheet }) => {
      await app.whenReady();
      const { createWindowsTrayIcon } = (globalThis as any).trayRenderer;
      const fs = (globalThis as any).trayFs;
      const width = 600, height = 150;
      const canvas = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const shade = y < height / 2 ? 238 : 32, offset = (y * width + x) * 4;
        canvas[offset] = canvas[offset + 1] = canvas[offset + 2] = shade; canvas[offset + 3] = 255;
      }
      const values: Array<{ badge: boolean; scale: number; bytes: number; color: number }> = [];
      for (const badge of [false, true]) {
        const icon = createWindowsTrayIcon(artwork, badge);
        for (const [index, scale] of [1, 1.25, 1.5, 2, 3].entries()) {
          const size = Math.round(16 * scale), pixels = icon.toBitmap({ scaleFactor: scale });
          let color = 0;
          for (let p = 0; p < pixels.length; p += 4) if (pixels[p + 3] > 100 && pixels[p] - pixels[p + 2] > 40) color++;
          values.push({ badge, scale, bytes: pixels.length, color });
          for (const top of [8, 83]) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const source = (y * size + x) * 4, dest = ((top + y) * width + index * 112 + (badge ? 56 : 4) + x) * 4;
            if (dest < 0 || dest + 3 >= canvas.length) continue;
            const alpha = pixels[source + 3] / 255;
            for (let channel = 0; channel < 3; channel++) canvas[dest + channel] = Math.round(pixels[source + channel] * alpha + canvas[dest + channel] * (1 - alpha));
          }
        }
      }
      fs.writeFileSync(sheet, nativeImage.createFromBitmap(canvas, { width, height }).toPNG());
      return values;
    }, { artwork, sheet });
    expect(metrics).toHaveLength(10);
    for (const metric of metrics) {
      expect(metric.bytes).toBe(Math.round(16 * metric.scale) ** 2 * 4);
      expect(metric.color).toBeGreaterThan(8);
    }
    await info.attach('Light and dark tray artwork', { path: sheet, contentType: 'image/png' });
  } finally { await app.close(); }
});
