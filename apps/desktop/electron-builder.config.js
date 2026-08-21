/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.micracode.app",
  productName: "Micracode",
  copyright: "Copyright © 2025 Micracode",
  files: [
    "dist/**/*",
    "!dist/**/*.map",
  ],
  extraResources: [
    {
      from: "../../apps/web/out",
      to: "web",
      filter: ["**/*"],
    },
    {
      from: "resources/backend",
      to: "backend",
      filter: ["**/*"],
    },
  ],
  directories: {
    output: "release",
  },
  publish: [
    {
      provider: "github",
      owner: "Jamessdevops",
      repo: "micracode",
      releaseType: "draft",
    },
  ],
  mac: {
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    icon: "resources/icon.icns",
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    // Signing: electron-builder auto-picks your "Developer ID Application" cert
    // from the login keychain. Notarization reads APPLE_ID /
    // APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID from env.
    notarize: true,
  },
  dmg: {
    // Standard drag-to-Applications layout.
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
};
