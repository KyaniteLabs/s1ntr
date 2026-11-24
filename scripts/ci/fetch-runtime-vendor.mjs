#!/usr/bin/env node
// CI only: before the tests, put each RUNTIME_FETCHED_ASSETS file (GSAP) into vendor/.
// The public tree does not ship these bytes (src/utils/vendorAssets.ts). Without this
// step every test that renders with GSAP fetches the CDN mid-test and times out on a
// slow network. Bytes come from the pinned URL and must match the pinned sha256
// (fetchPinnedRuntimeAsset); they land in the CI workspace only, never in git.
// Needs `pnpm build` first. A file already on disk (the private tree) is left alone.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const { RUNTIME_FETCHED_ASSETS, fetchPinnedRuntimeAsset, vendorRoot } =
  await import(new URL('../../dist/utils/vendorAssets.js', import.meta.url).href);

for (const [urlPath, pin] of Object.entries(RUNTIME_FETCHED_ASSETS)) {
  const file = vendorRoot() + urlPath.slice('/vendor/'.length);
  if (existsSync(file)) {
    const existing = await readFile(file);
    const digest = createHash('sha256').update(existing).digest('hex');
    if (digest === pin.sha256) {
      console.log(`runtime vendor: ${urlPath} already on disk (sha256 verified)`);
      continue;
    }
    console.warn(`runtime vendor: ${urlPath} on disk sha256 mismatch (${digest}); re-fetching`);
  }
  let body;
  let lastErr;
  for (let attempt = 1; attempt <= 3 && body === undefined; attempt++) {
    try {
      body = await fetchPinnedRuntimeAsset(urlPath);
    } catch (err) {
      lastErr = err;
      console.error(`runtime vendor: ${urlPath} attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  if (body === undefined) throw lastErr;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await writeFile(tmp, body);
  await rename(tmp, file);
  console.log(`runtime vendor: ${urlPath} fetched from ${pin.url}, sha256 ${pin.sha256}`);
}
