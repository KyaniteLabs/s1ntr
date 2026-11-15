import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseUltraQABootstrap, runDeterministicUltraQA } from '../../src/runtime-core/DeterministicUltraQA.js';

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage(): never {
  console.error('Usage: pnpm wave8:deterministic-ultraqa -- --output-dir .quality/wave-8/release [--bootstrap-root <root.json>]');
  process.exit(2);
}

async function main(): Promise<void> {
  const bootstrapPath = value('--bootstrap-root') ?? value('--root');
  const outputDir = value('--output-dir');
  if (!outputDir) usage();
  const repoRoot = process.cwd();
  const target = path.resolve(outputDir);
  const relativeTarget = path.relative(repoRoot, target).replaceAll(path.sep, '/');
  if (relativeTarget !== '.quality/wave-8/release') {
    throw new Error('Ultra QA output must be the canonical ignored .quality/wave-8/release directory');
  }
  const bootstrap = bootstrapPath
    ? parseUltraQABootstrap(JSON.parse(await readFile(path.resolve(bootstrapPath), 'utf8')) as unknown)
    : undefined;
  const result = await runDeterministicUltraQA(repoRoot, bootstrap, undefined, target);
  process.stdout.write(`${JSON.stringify({ receiptCount: result.receipts.length, releaseReady: result.releaseReady, blockers: result.blockers, releaseRootDigest: result.root.releaseRootDigest }, null, 2)}\n`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
