// Recreate the app icon (purple gradient squircle + 7 white waveform bars,
// symmetric, tallest in center) and rasterize the source PNGs that
// @capacitor/assets consumes:
//   assets/icon.png            (1024, full composite — legacy launcher + macOS)
//   assets/icon-foreground.png (1024, white bars on transparent, in safe zone)
//   assets/icon-background.png (1024, full-bleed gradient — adaptive background)
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, 'assets');
fs.mkdirSync(OUT, { recursive: true });

const W = 1024;
const grad = `
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7C5CFF"/>
    <stop offset="1" stop-color="#5547EA"/>
  </linearGradient>`;

// 7 bars: width 72, gap 44, centered; symmetric heights (center tallest).
const bw = 72, gap = 44, n = 7;
const heights = [250, 470, 620, 800, 620, 470, 250];
const total = n * bw + (n - 1) * gap;
const startX = (W - total) / 2;
function bars(scale) {
  // scale about center (for the adaptive foreground safe zone)
  let r = `<g transform="translate(${W / 2} ${W / 2}) scale(${scale}) translate(${-W / 2} ${-W / 2})" fill="#FFFFFF">`;
  for (let i = 0; i < n; i++) {
    const x = startX + i * (bw + gap);
    const h = heights[i];
    const y = (W - h) / 2;
    r += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="${bw / 2}" ry="${bw / 2}"/>`;
  }
  return r + '</g>';
}

const composite = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <defs>${grad}</defs>
  <rect width="${W}" height="${W}" rx="230" ry="230" fill="url(#g)"/>
  ${bars(1)}
</svg>`;

const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <defs>${grad}</defs>
  <rect width="${W}" height="${W}" fill="url(#g)"/>
</svg>`;

// adaptive foreground: bars only, transparent. Full scale — @capacitor/assets
// adds the 16.7% safe-zone inset, so bars end up ~0.5 of the masked icon.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  ${bars(1)}
</svg>`;

async function png(svg, name) {
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, name));
  console.log('wrote', name);
}
(async () => {
  await png(composite, 'icon.png');
  await png(background, 'icon-background.png');
  await png(foreground, 'icon-foreground.png');
  // also drop a copy for the macOS shell (electron-builder mac.icon)
  await sharp(Buffer.from(composite)).png().toFile(path.join(__dirname, '..', 'mac-shell', 'icon.png'));
  console.log('wrote ../mac-shell/icon.png');
})();
