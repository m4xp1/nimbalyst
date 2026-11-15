// Use the original high-resolution brand artwork, never upscale a 16px tray image.
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../assets/nimbalyst-icon.png', import.meta.url));
const output = fileURLToPath(new URL('../packages/electron/resources/tray-windows/', import.meta.url));
const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
// The blue silhouette becomes monochrome; the white hash becomes transparent.
// Chroma retains antialiasing on both the outer contour and the hash.
for (let p = 0; p < data.length; p += 4) {
  data[p + 3] = Math.round(data[p + 3] * Math.min(1, Math.max(0, (data[p + 2] - data[p]) / 156)));
  data[p] = data[p + 1] = data[p + 2] = 32;
}
const silhouette = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .trim({ threshold: 1 }).png().toBuffer();
await mkdir(output, { recursive: true });
const sizes = [16, 20, 24, 28, 32, 40, 48, 64, 256];
for (const size of sizes) {
  await sharp(silhouette).resize(size, size, { fit: 'contain', background: '#00000000', kernel: 'lanczos3' })
    .png().toFile(`${output}/${size}.png`);
}

// A NativeImage assembled with addRepresentation still becomes its 1x bitmap
// in Electron's Windows GetHICON path. Loading an ICO path uses LoadImage(size)
// instead, so Windows selects the exact native-size frame without stretching.
for (const badge of [false, true]) {
  const frames = [];
  for (const size of sizes) {
    let png = await readFile(`${output}/${size}.png`);
    if (badge) {
      const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size * .77}" cy="${size * .77}" r="${size * .18}" fill="white"/><circle cx="${size * .77}" cy="${size * .77}" r="${size * .18 - Math.max(1, size / 16)}" fill="#3b82f6"/></svg>`);
      png = await sharp(png).composite([{ input: circle }]).png().toBuffer();
    }
    frames.push(png);
  }
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  for (let i = 0; i < frames.length; i++) {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frames[i].length;
  }
  await writeFile(`${output}/${badge ? 'notification' : 'idle'}.ico`, Buffer.concat([header, ...frames]));
}
