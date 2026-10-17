// Renders build/icon.svg into the icons electron-builder picks up from build/:
// icon.png (1024²), icon.ico (Windows, 16–256) and icon.icns (macOS).
// The tools aren't project dependencies; install them for the run only:
//   npm i --no-save sharp png2icons && node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import png2icons from 'png2icons';

const dir = path.join(import.meta.dirname, '..', 'build');
const png = await sharp(path.join(dir, 'icon.svg'), { density: 300 }).resize(1024, 1024).png().toBuffer();
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), png2icons.createICO(png, png2icons.BICUBIC2, 0, false, true));
fs.writeFileSync(path.join(dir, 'icon.icns'), png2icons.createICNS(png, png2icons.BICUBIC2, 0));
for (const f of ['icon.png', 'icon.ico', 'icon.icns']) console.log(f, fs.statSync(path.join(dir, f)).size, 'bytes');
