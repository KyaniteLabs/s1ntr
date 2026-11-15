import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sinter-wave7-pack-'));
try {
  execFileSync('pnpm', ['pack', '--pack-destination', temporary], { cwd: root, stdio: 'pipe' });
  const tarballName = fs.readdirSync(temporary).find(name => name.endsWith('.tgz'));
  if (!tarballName) throw new Error('pnpm pack did not create a tarball');
  const installRoot = path.join(temporary, 'consumer');
  fs.mkdirSync(installRoot);
  execFileSync('npm', ['init', '-y'], { cwd: installRoot, stdio: 'ignore' });
  execFileSync('npm', ['install', path.join(temporary, tarballName)], { cwd: installRoot, stdio: 'pipe' });
  const bin = path.join(installRoot, 'node_modules', 's1ntr', 'bin', 'sinter');
  const run = spawnSync(process.execPath, [bin, '--help'], { cwd: installRoot, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`packed sinter --help failed: ${run.stderr}`);
  const help = run.stdout;
  // Renders inline these vendored files; a tarball without them cannot render.
  const packageDir = path.dirname(path.dirname(bin));
  const vendorModule = pathToFileURL(path.join(packageDir, 'dist', 'utils', 'vendorAssets.js')).href;
  const { VENDOR_ASSETS, readVendorAsset } = await import(vendorModule);
  const vendorAssets = Object.values(VENDOR_ASSETS);
  const missingVendor = [];
  for (const asset of vendorAssets) {
    await readVendorAsset(asset).catch(() => missingVendor.push(asset));
  }
  const helpOk = help.includes('Creative Coding Agent') && help.includes('organism <inspect|react|context>');
  const passed = helpOk && vendorAssets.length > 0 && missingVendor.length === 0;
  console.log(JSON.stringify({ gate: 'packed-install-smoke', passed, helpOk, vendorAssets: vendorAssets.length, missingVendor, tarball: path.basename(tarballName) }));
  if (!passed) process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
