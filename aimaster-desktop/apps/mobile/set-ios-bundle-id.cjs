// set-ios-bundle-id.cjs — set the iOS bundle identifier AFTER `npx cap add ios`.
//
// Capacitor derives the native bundle id from capacitor.config.ts `appId`
// (com.louver.mastering.mobile = the ANDROID applicationId). iOS must use a
// DISTINCT id: com.louver.mastering.ios (already registered in App Store
// Connect). ios/ is gitignored + regenerated, so this script is the persistent
// definition — run it every time after `cap add ios` (the runbook does).
//
// Usage:  node set-ios-bundle-id.cjs          # → com.louver.mastering.ios
//         IOS_BUNDLE_ID=... node set-ios-bundle-id.cjs
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_ID = process.env.IOS_BUNDLE_ID || 'com.louver.mastering.ios';
const pbx = path.join(__dirname, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

if (!fs.existsSync(pbx)) {
  console.error(`[ios] project.pbxproj not found — run \`npx cap add ios\` first:\n  ${pbx}`);
  process.exit(1);
}

let s = fs.readFileSync(pbx, 'utf8');
const re = /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g;
const found = (s.match(re) || []).length;
s = s.replace(re, `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`);
fs.writeFileSync(pbx, s);

console.log(`[ios] PRODUCT_BUNDLE_IDENTIFIER → ${BUNDLE_ID}  (${found} occurrence(s) in project.pbxproj)`);
if (found === 0) {
  console.error('[ios] WARNING: no PRODUCT_BUNDLE_IDENTIFIER lines matched — check the Xcode project.');
  process.exit(1);
}
