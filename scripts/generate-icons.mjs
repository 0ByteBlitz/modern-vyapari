/**
 * generate-icons.mjs
 *
 * Rasterises assets/icon.svg into multi-size PNGs and bundles them
 * into a Windows .ico file. Run via: npm run generate-icons
 *
 * Dependencies (devDependencies):
 *   - sharp        — SVG → PNG rasterisation
 *   - png-to-ico   — PNG → ICO bundling
 */

import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, "..");
const ASSETS = resolve(ROOT, "assets");
const ICONS_DIR = resolve(ASSETS, "icons");
const SVG_PATH = resolve(ASSETS, "icon.svg");

// Sizes included in the .ico (standard Windows icon sizes)
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Extra large PNG for packaging / Linux / macOS
const EXTRA_SIZES = [512];

async function main() {
  // Ensure output directories exist
  if (!existsSync(ICONS_DIR)) {
    mkdirSync(ICONS_DIR, { recursive: true });
  }

  const svgBuffer = readFileSync(SVG_PATH);
  const allSizes = [...ICO_SIZES, ...EXTRA_SIZES];

  console.log(`📐  Rasterising icon.svg → ${allSizes.length} PNG sizes...`);

  // Generate all PNGs
  const pngBuffers = new Map();

  for (const size of allSizes) {
    const pngBuf = await sharp(svgBuffer)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const outPath = resolve(ICONS_DIR, `icon-${size}.png`);
    writeFileSync(outPath, pngBuf);
    pngBuffers.set(size, pngBuf);
    console.log(`   ✓ icon-${size}.png  (${pngBuf.length} bytes)`);
  }

  // Copy 512px as assets/icon.png (used by macOS packaging + HTML favicon)
  const png512 = pngBuffers.get(512);
  writeFileSync(resolve(ASSETS, "icon.png"), png512);
  console.log(`   ✓ icon.png (512px copy)`);

  // Bundle ICO sizes into a single .ico
  console.log(`\n📦  Bundling ${ICO_SIZES.length} sizes into icon.ico...`);

  const icoInputPaths = ICO_SIZES.map((s) => resolve(ICONS_DIR, `icon-${s}.png`));
  const icoBuf = await pngToIco(icoInputPaths);
  writeFileSync(resolve(ASSETS, "icon.ico"), icoBuf);
  console.log(`   ✓ icon.ico  (${icoBuf.length} bytes)`);

  console.log(`\n✅  Done! All icons written to assets/`);
}

main().catch((err) => {
  console.error("❌  Icon generation failed:", err);
  process.exit(1);
});
