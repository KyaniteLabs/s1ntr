/** `sinter learn-from-existing-art`: parse flags, run the digest, print the per-organ report. */
import os from 'node:os';
import path from 'node:path';
import { runDigest, type DigestOptions, type DigestReport } from '../learning/ExistingArtDigest.js';

export const LEARN_FROM_EXISTING_ART_USAGE = `Usage: sinter learn-from-existing-art --root <runs-dir> [--root ...] [--dry-run] [--with-model-calls] [options]
  Inventories finished pieces and replays verified Create evidence, oldest first.
  --root <dir>            run folders to read (read-only); repeatable
  --project-root <dir>    where fitness/archive/trend/champion/rejects/compost stores are written (default: current directory)
  --home <dir>            home for ~/.sinter stores (default: $HOME)
  --learning-dir <dir>    digest inventory, receipts, and holdout files (default: <project-root>/.sinter/learning)
  --likes <file[,file]>   owner like/dislike log(s) (jsonl: seat, id, vote or liked, at); latest vote per piece wins
  --wall <dir>           include unverified wall items in the inventory
  --state-root <dir>     shared signed Create journal for batch output directories
  --holdout-prompts <file> --holdout-files <file>   manifest prompt inventory or source/artifact digest holdout
  --freeze-holdout-percent <n>      freeze n% of pieces as holdout if none exists yet
  --with-model-calls      show model-assisted readiness (historical Create cannot authorize model calls)
  --limit <n>             first n pieces by date
  --dry-run               write nothing; print per-organ counts
  --json                  print the report as JSON`;

export function parseDigestArgs(argv: readonly string[], cwd = process.cwd(), env = process.env): { opts: DigestOptions; json: boolean } {
  const roots: string[] = []; const v: Record<string, string> = {}; const flag = new Set<string>();
  const withValue = new Set(['--root', '--project-root', '--home', '--learning-dir', '--likes', '--wall', '--crosswalk', '--state-root', '--holdout-prompts', '--holdout-files', '--freeze-holdout-percent', '--limit']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (withValue.has(a)) { const val = argv[++i]; if (val === undefined) throw new Error(`${a} needs a value`); if (a === '--root') roots.push(path.resolve(cwd, val)); else v[a] = val; }
    else if (['--dry-run', '--with-model-calls', '--skip-python', '--json'].includes(a)) flag.add(a);
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!roots.length) throw new Error('at least one --root is required');
  const projectRoot = path.resolve(cwd, v['--project-root'] ?? '.');
  const num = (k: string): number | undefined => (v[k] === undefined ? undefined : Number(v[k]));
  for (const k of ['--limit', '--freeze-holdout-percent']) { const n = num(k); if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new Error(`${k} must be a non-negative number`); }
  const rel = (k: string): string | undefined => (v[k] ? path.resolve(cwd, v[k]) : undefined);
  return { json: flag.has('--json'), opts: { roots, projectRoot, home: rel('--home') ?? env.HOME ?? os.homedir(),
    learningDir: rel('--learning-dir') ?? path.join(projectRoot, '.sinter', 'learning'), likesFile: v['--likes'] ? v['--likes'].split(',').map(f => path.resolve(cwd, f)).join(',') : undefined, wallDir: rel('--wall'), stateRoot: rel('--state-root'),
    holdoutPrompts: rel('--holdout-prompts'), holdoutFiles: rel('--holdout-files'), freezeHoldoutPercent: num('--freeze-holdout-percent'),
    dryRun: flag.has('--dry-run'), withModelCalls: flag.has('--with-model-calls'), skipPython: flag.has('--skip-python'), limit: num('--limit') || undefined,
    log: (l: string) => console.error(l) } };
}

export function formatDigestReport(r: DigestReport): string {
  const out: string[] = [`${r.dryRun ? 'DRY RUN (nothing written)' : 'DIGEST'} ${r.runId}: ${r.pieces} pieces (${r.duplicatesDropped} duplicates dropped), ${r.dateRange.first || '?'} .. ${r.dateRange.last || '?'}`];
  for (const s of r.roots) out.push(`  root ${s.root}: pieces=${s.pieces} code=${s.withCode} render=${s.withRender} score=${s.withScore} accepted=${s.accepted} liked=${s.liked} disliked=${s.disliked} held=${s.held}`);
  out.push(`  holdout: ${r.holdout.state}, prompts=${r.holdout.prompts} files=${r.holdout.files} held-pieces=${r.holdout.heldPieces}`);
  out.push(`  ${'organ'.padEnd(16)} ${r.dryRun ? 'would-write' : 'written'} already-done n/a failed`);
  for (const [o, c] of Object.entries(r.organs)) out.push(`  ${o.padEnd(16)} ${String(r.dryRun ? c.wouldWrite : c.written).padStart(11)} ${String(c.alreadyDone).padStart(12)} ${String(c.notApplicable).padStart(3)} ${String(c.failed).padStart(6)}`);
  for (const n of r.notes) out.push(`  note: ${n}`);
  return out.join('\n');
}

export async function runLearnFromExistingArt(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) { console.log(LEARN_FROM_EXISTING_ART_USAGE); return argv.length === 0 ? 1 : 0; }
  let parsed; try { parsed = parseDigestArgs(argv); } catch (e) { console.error(`${(e as Error).message}\n${LEARN_FROM_EXISTING_ART_USAGE}`); return 1; }
  let report: DigestReport;
  try { report = await runDigest(parsed.opts); }
  catch (error) {
    console.error(`learn-from-existing-art: ${(error as Error).message}`);
    return 1;
  }
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatDigestReport(report));
  return Object.values(report.organs).some(c => c.failed > 0) ? 2 : 0;
}
