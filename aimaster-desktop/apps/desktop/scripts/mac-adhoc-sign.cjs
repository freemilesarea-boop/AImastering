/**
 * mac-adhoc-sign.cjs — electron-builder `afterPack` hook.
 *
 * The release pipeline has no Developer ID yet (see electron-builder.yml
 * `mac.identity` TODO), so CI runs with CSC_IDENTITY_AUTO_DISCOVERY=false and
 * electron-builder skips code signing entirely.  A completely unsigned bundle
 * is the worst of the available options on macOS:
 *
 *   • Apple Silicon refuses to execute unsigned arm64 code outright.
 *   • Intel launches it, but a bundle whose contents were modified after
 *     packaging (we drop ffmpeg/ffprobe/engine into Resources/bin via
 *     extraResources) can trip Gatekeeper's "손상되었기 때문에 열 수 없습니다"
 *     path instead of the recoverable "확인되지 않은 개발자" prompt.
 *
 * An ad-hoc signature (`codesign --sign -`) costs nothing, needs no
 * certificate, and makes the bundle internally consistent so the OS reports
 * the honest "unidentified developer" state that a user can accept.  It does
 * NOT replace notarization — downloads still carry the quarantine bit, so the
 * install docs still tell users to clear it.
 *
 * Runs before the .dmg / .zip are assembled, so the signature ships inside
 * both.  Deliberately never fails the build: signing is an improvement here,
 * not a requirement, and a hook failure would cost us the artefacts entirely.
 */

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function macAdhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // A real identity means electron-builder will sign properly on its own.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[mac-adhoc-sign] real signing identity present — skipping ad-hoc pass');
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`[mac-adhoc-sign] ad-hoc signing ${appPath} (arch=${context.arch})`);
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
      { stdio: 'inherit' },
    );
    execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
    console.log('[mac-adhoc-sign] ok');
  } catch (err) {
    console.warn(`[mac-adhoc-sign] skipped — ${err.message}`);
    console.warn('[mac-adhoc-sign] the build continues; the bundle is simply unsigned.');
  }
};
