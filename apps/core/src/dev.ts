/** Standalone runner: `bun run apps/core/src/dev.ts` (or `npm run dev`). */

import { startCoreServer } from "./index.js";

const port = Number(process.env.PORT ?? "8000") || 8000;

startCoreServer({ port }).then((server) => {
  // eslint-disable-next-line no-console
  console.log(`[core] listening on ${server.url}`);
});
