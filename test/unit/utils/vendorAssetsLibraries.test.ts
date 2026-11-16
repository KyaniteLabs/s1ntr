import { describe, it, expect } from 'vitest';
import { VENDORED_LIBRARIES } from '../../../src/core/wrappers/VendoredLibraries.js';
import { isVendorAssetPath, readVendorAsset } from '../../../src/utils/vendorAssets.js';

// Every library the prompts offer must also be servable by the renderer.
// On 11-16 a GLM p5 piece that loaded culori died at render with
// "unregistered vendored asset: /vendor/culori/4.0.2/culori.min.js": the
// library index listed 18 files the renderer's allowlist did not.
const FILES = Object.entries(VENDORED_LIBRARIES)
  .filter(([, entry]) => !entry.file.endsWith('/'))
  .map(([id, entry]) => [id, entry.file] as const);

describe('vendored library files are servable', () => {
  it.each(FILES)('%s (%s) is a registered vendor asset', async (_id, file) => {
    expect(isVendorAssetPath(file)).toBe(true);
    await expect(readVendorAsset(file)).resolves.toEqual(expect.any(String));
  });

  it('still rejects paths outside the index', async () => {
    expect(isVendorAssetPath('/vendor/culori/4.0.2/../../../package.json')).toBe(false);
    await expect(readVendorAsset('/vendor/not-a-lib/1.0.0/x.js')).rejects.toThrow(/unregistered/);
  });
});
