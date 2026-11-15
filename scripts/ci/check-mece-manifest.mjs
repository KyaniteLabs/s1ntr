#!/usr/bin/env node
import { buildManifest, validateManifest } from '../mece/manifest.mjs';

const manifest = buildManifest();
const v = validateManifest(manifest);
if (!v.ok) {
  console.error('check:mece-manifest FAILED');
  for (const e of v.errors) console.error(' -', e);
  console.error('unowned sample:', manifest.unowned.slice(0, 30));
  process.exit(1);
}
console.log('check:mece-manifest OK', manifest.counts);
process.exit(0);
