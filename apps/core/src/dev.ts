/** Standalone runner: `bun run apps/core/src/dev.ts` (or `npm run dev`). */

import { startCoreServer } from "./index.js";

const port = Number(process.env.PORT ?? "8000") || 8000;

// The browser-only dev stack can't receive a per-launch token the way the
// Electron preload does, so both sides read the same value from env.
const token = process.env.MICRACODE_API_TOKEN?.trim();
if (!token) {
  console.error(
    "[core] MICRACODE_API_TOKEN is not set. Pick any long random string and set it\n" +
      "       here AND as NEXT_PUBLIC_MICRACODE_API_TOKEN in apps/web/.env.local, e.g.\n" +
      "       export MICRACODE_API_TOKEN=$(openssl rand -hex 32)",
  );
  process.exit(1);
}

startCoreServer({ port, token }).then((server) => {
  // eslint-disable-next-line no-console
  console.log(`[core] listening on ${server.url}`);
});
