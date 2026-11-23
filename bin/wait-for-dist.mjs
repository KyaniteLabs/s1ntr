// Imported first by bin/sinter. If `pnpm build` is swapping dist in right now (the swap lock exists and dist is not
// there yet), wait briefly instead of dying with ERR_MODULE_NOT_FOUND. The normal swap is an atomic exchange with no gap;
// this covers the two-rename fallback used where the exchange is unavailable.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = `${root}dist`;
const lock = `${root}dist.swap-lock`;
const deadline = Date.now() + 10_000;
while (!existsSync(dist) && existsSync(lock) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
