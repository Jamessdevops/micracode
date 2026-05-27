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
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "resources/icon.ico",
  },
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    icon: "resources/icon.icns",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
  },
  linux: {
    target: [{ target: "AppImage", arch: ["x64"] }],
    icon: "resources/icon.png",
    category: "Development",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  publish: {
    provider: "github",
    releaseType: "release",
  },
};
