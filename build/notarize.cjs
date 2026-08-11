// afterSign hook: notarize the signed .app — but only when Apple credentials are
// present. This keeps a local `pnpm dist` working (it skips notarization)
// while a credentialed build notarizes automatically. See CONTRIBUTING.md.
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Apple credentials not set — skipping notarization (local/unsigned build).')
    return
  }

  let notarize
  try {
    ;({ notarize } = require('@electron/notarize'))
  } catch {
    console.log('[notarize] @electron/notarize not installed — skipping. `pnpm add -D @electron/notarize` to enable.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  console.log(`[notarize] submitting ${appName}.app …`)
  await notarize({
    appBundleId: 'com.zede.app',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  })
  console.log('[notarize] done.')
}
