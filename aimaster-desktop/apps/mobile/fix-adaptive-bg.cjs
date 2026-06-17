// @capacitor/assets insets BOTH adaptive layers 16.7%. That's right for the
// foreground (safe zone) but shrinks our full-bleed gradient background, leaving
// transparent corners after the launcher mask. Rewrite the background of each
// adaptive XML to a non-inset, full-bleed drawable.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'android/app/src/main/res/mipmap-anydpi-v26');
const files = ['ic_launcher.xml', 'ic_launcher_round.xml'];
const fullBleed = '    <background android:drawable="@mipmap/ic_launcher_background" />';
// matches the generated <background>…<inset .../></background> block
const re = /<background>\s*<inset[^>]*android:drawable="@mipmap\/ic_launcher_background"[^>]*\/>\s*<\/background>/;

let changed = 0;
for (const f of files) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  if (!re.test(src)) {
    console.log(`skip ${f} (background already full-bleed or unexpected format)`);
    continue;
  }
  fs.writeFileSync(p, src.replace(re, fullBleed));
  console.log(`patched ${f} → full-bleed background`);
  changed++;
}
console.log(`adaptive background patched: ${changed} file(s)`);
