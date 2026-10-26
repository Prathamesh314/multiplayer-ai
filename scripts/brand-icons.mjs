/**
 * Builds every app icon from the Multicode AI mark (public/brand/multicode-mark.png,
 * the logo lifted off its paper background). The mark's darkest faces are
 * near black, so it always sits on a tile of its paper colour: on a dark tab
 * bar, dock or header a bare mark would lose its middle.
 *
 *   node scripts/brand-icons.mjs
 *
 * Writes: app/icon.png and app/favicon.ico (browser tabs), app/apple-icon.png
 * (home screens), desktop/icon.png (app, window and tray icon) and
 * public/brand/multicode-tile.png (the mark shown in the app and on the site).
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = join(root, "public/brand/multicode-mark.png");
const PAPER = "#f3f2ee";

/**
 * The mark centred on a paper tile. `inset` is the transparent margin around
 * the tile (macOS draws app icons inside one), `radius` the tile's corner as
 * a share of its side (0 for a full square that the OS masks itself), `width`
 * how much of the tile the mark spans.
 */
async function tile(size, { inset = 0, radius = 0.22, width = 0.8 } = {}) {
  const side = size - 2 * inset;
  const r = Math.round(side * radius);
  const card = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${r}" ry="${r}" fill="${PAPER}"/></svg>`);
  const markWidth = Math.round(side * width);
  const mark = await sharp(MARK).resize({ width: markWidth, kernel: "lanczos3" }).png().toBuffer();
  const { height: markHeight } = await sharp(mark).metadata();
  return sharp(card).composite([{ input: mark, left: Math.round((size - markWidth) / 2), top: Math.round((size - markHeight) / 2) }]).png({ compressionLevel: 9 }).toBuffer();
}

/** An .ico of PNG images, which every current browser reads. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2); header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(image => image.data)]);
}

// Tiny sizes give the mark more of the tile, so it stays legible in a tab.
const favicons = await Promise.all([16, 32, 48].map(async size => ({ size, data: await tile(size, { radius: 0.2, width: 0.92 }) })));
await writeFile(join(root, "app/favicon.ico"), ico(favicons));
await writeFile(join(root, "app/icon.png"), await tile(512, { width: 0.84 }));
await writeFile(join(root, "app/apple-icon.png"), await tile(180, { radius: 0, width: 0.78 }));
// Same footprint as before: a rounded square 32 px inside the 1024 canvas.
await writeFile(join(root, "desktop/icon.png"), await tile(1024, { inset: 32, radius: 224 / 960, width: 0.78 }));
await writeFile(join(root, "public/brand/multicode-tile.png"), await tile(128, { radius: 0.24, width: 0.86 }));
console.log("Icons written from", MARK);
