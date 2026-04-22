/**
 * Convert SVG animations to GIF using Puppeteer
 * Usage: node scripts/svg-to-gif.js
 */

const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const FRAME_RATE = 20;
const DURATION_SEC = 4;
const TOTAL_FRAMES = FRAME_RATE * DURATION_SEC;
const WIDTH = 800;
const HEIGHT = 600;

const SVG_FILES = [
  'demo-screen-analysis',
  'demo-knowledge-base',
  'demo-screenshot-capture'
];

async function svgToGif(name) {
  const svgPath = path.join(ASSETS_DIR, `${name}.svg`);
  const gifPath = path.join(ASSETS_DIR, `${name}.gif`);
  const framesDir = path.join(ASSETS_DIR, '.frames');

  if (!fs.existsSync(svgPath)) {
    console.error(`SVG not found: ${svgPath}`);
    return;
  }

  // Create frames directory
  if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  console.log(`Converting ${name}.svg → ${name}.gif ...`);

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });

  // Load SVG in an HTML page
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  const html = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #1A1614; }
  svg { width: 100%; height: 100%; }
</style></head><body>${svgContent}</body></html>`;

  await page.setContent(html, { waitUntil: 'networkidle0' });

  // Capture frames
  const frameInterval = 1000 / FRAME_RATE;
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const framePath = path.join(framesDir, `frame-${String(i).padStart(4, '0')}.png`);
    await page.screenshot({ path: framePath });
    await page.evaluate((ms) => new Promise(r => setTimeout(r, ms)), frameInterval);

    if (i % 10 === 0) process.stdout.write(`  ${Math.round(i / TOTAL_FRAMES * 100)}%`);
  }
  console.log('  100%');

  await browser.close();

  // Use ffmpeg to create GIF with palette
  console.log(`  Encoding GIF...`);
  const palettePath = path.join(framesDir, 'palette.png');

  execSync(
    `ffmpeg -y -framerate ${FRAME_RATE} -i "${framesDir}/frame-%04d.png" ` +
    `-vf "fps=${FRAME_RATE},scale=${WIDTH}:-1:flags=lanczos,palettegen=stats_mode=diff" ` +
    `"${palettePath}"`,
    { stdio: 'pipe' }
  );

  execSync(
    `ffmpeg -y -framerate ${FRAME_RATE} -i "${framesDir}/frame-%04d.png" -i "${palettePath}" ` +
    `-lavfi "fps=${FRAME_RATE},scale=${WIDTH}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" ` +
    `"${gifPath}"`,
    { stdio: 'pipe' }
  );

  // Cleanup frames
  fs.rmSync(framesDir, { recursive: true });

  const stats = fs.statSync(gifPath);
  console.log(`  ✓ ${gifPath} (${(stats.size / 1024).toFixed(0)} KB)`);
}

(async () => {
  for (const name of SVG_FILES) {
    await svgToGif(name);
  }
  console.log('\nDone!');
})().catch(e => { console.error(e); process.exit(1); });
