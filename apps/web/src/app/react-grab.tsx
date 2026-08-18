"use client";

import { useEffect } from "react";

/**
 * Loads react-grab (https://npm.im/react-grab) in development only. Hover a UI
 * element and press ⌘C / Ctrl+C to copy its source context for a coding agent.
 *
 * The desktop ships a production static export, so `NODE_ENV` is baked to
 * "production" there — the preload injects `__MICRACODE_DEV__` when the app runs
 * unpackaged, and that's what gates the load inside the Electron dev build. The
 * `NODE_ENV` check keeps it working under a plain `next dev` in the browser too.
 */
export function ReactGrab() {
  useEffect(() => {
    const desktopDev = (window as { __MICRACODE_DEV__?: boolean }).__MICRACODE_DEV__;
    if (process.env.NODE_ENV === "development" || desktopDev) {
      import("react-grab").catch(() => {});
    }
  }, []);

  return null;
}
