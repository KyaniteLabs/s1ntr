#!/usr/bin/env node
/**
 * Outer meta loop — draft harvest / claims / dreams / priors / interwave queue after a stamp.
 *
 * Does NOT auto-merge product PRs. Does NOT rewrite tour-seat-live-freeze.json unless
 * LIMINAL_APPLY_FREEZE=1 and --apply-freeze.
 *
 * Usage:
 *   node scripts/rotation/outer-meta-loop.mjs --stamp-dir .quality/tour/wave-2/<stamp>
 *   node scripts/rotation/outer-meta-loop.mjs --wave 2 --latest
 *   node scripts/rotation/outer-meta-loop.mjs --stamp-dir PATH --apply-docs --apply-claims --apply-priors
 *
 * wave2-run hooks this unless LIMINAL_OUTER_META=0.
 */
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimFingerprint,
  appendClaimLifecycle,
  readClaimLedger,
  resolveGitTip,
  REPO_ROOT,
  DEFAULT_CLAIM_LEDGER,
} from './tour-instrumentation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = REPO_ROOT;
const FREEZE_PATH = path.join(REPO, 'docs/agents/waves/tour-seat-live-freeze.json');
const DOCS_WAVES = path.join(REPO, 'docs/agents/waves');

export function parseArgs(argv) {
  const out = {
    stampDir: null,
    wave: null,
    latest: false,
    applyDocs: true,
    applyClaims: true,
    applyPriors: true,
    applyFreeze: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stamp-dir' && argv[i + 1]) out.stampDir = path.resolve(argv[++i]);
    else if (a === '--wave' && argv[i + 1]) out.wave = String(argv[++i]);
    else if (a === '--latest') out.latest = true;
    else if (a === '--apply-docs') out.applyDocs = true;
    else if (a === '--no-docs') out.applyDocs = false;
    else if (a === '--apply-claims') out.applyClaims = true;
    else if (a === '--no-claims') out.applyClaims = false;
    else if (a === '--apply-priors') out.applyPriors = true;
    else if (a === '--no-priors') out.applyPriors = false;
    else if (a === '--apply-freeze') out.applyFreeze = true;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

export function resolveLatestStampDir(wave) {
  const root = path.join(REPO, '.quality', 'tour', `wave-${wave}`);
  if (!fsSync.existsSync(root)) return null;
  const dirs = fsSync
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (!dirs.length) return null;
  return path.join(root, dirs[dirs.length - 1]);
}

export function loadJsonSafe(p) {
  try {
    return JSON.parse(fsSync.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Scan stamp seat packs for summaries + productCandidate receipts.
 */
export function extractStampEvidence(stampDir) {
  const seats = [];
  const productCandidates = [];
  if (!stampDir || !fsSync.existsSync(stampDir)) {
    return { seats, productCandidates, report: null };
  }
  const report = loadJsonSafe(path.join(stampDir, 'wave2-run-report.json'));
  const checkpoint = loadJsonSafe(path.join(stampDir, 'wave2-checkpoint.json'));

  for (const name of fsSync.readdirSync(stampDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const packDir = path.join(stampDir, name.name);
    const summary = loadJsonSafe(path.join(packDir, 'summary.json'));
    if (!summary) continue;
    const seat = summary.seat || name.name.split('-')[0];
    const ns = summary.northStar?.value ?? summary.metrics?.northStar ?? null;
    seats.push({
      pack: name.name,
      seat,
      model: summary.model ?? null,
      mode: summary.mode ?? null,
      northStar: ns,
      northStarId: summary.northStar?.id ?? summary.metrics?.northStarId ?? null,
      join: summary.join ?? null,
    });

    const receiptsDir = path.join(packDir, 'receipts');
    if (!fsSync.existsSync(receiptsDir)) continue;
    for (const f of fsSync.readdirSync(receiptsDir)) {
      if (!f.endsWith('.json') || f.includes('envelope')) continue;
      const rec = loadJsonSafe(path.join(receiptsDir, f));
      if (!rec) continue;
      const pc =
        rec.metrics?.productCandidate
        ?? rec.extra?.raw?.productCandidate
        ?? rec.extra?.productCandidate
        ?? null;
      if (pc === true || pc === 'true') {
        productCandidates.push({
          seat,
          model: summary.model ?? rec.model ?? null,
          taskId: rec.taskId || f.replace(/\.json$/, ''),
          verdict: rec.verdict ?? null,
          pack: name.name,
          receipt: path.join(receiptsDir, f),
        });
      }
    }
  }

  return { seats, productCandidates, report, checkpoint, stampDir };
}

export function renderHarvestMarkdown(ev, { wave, tip, stamp }) {
  const lines = [];
  lines.push(`# Wave ${wave} — Auto harvest`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Stamp:** \`${stamp}\``);
  lines.push(`**Tip:** \`${tip || 'unknown'}\``);
  lines.push(`**Source:** outer-meta-loop (OML-1)`);
  lines.push('');
  lines.push('## Scoreboard (from stamp summaries)');
  lines.push('');
  lines.push('| Seat | Pack | Model | Mode | NS |');
  lines.push('|------|------|-------|------|-----|');
  for (const s of ev.seats) {
    lines.push(
      `| ${s.seat} | \`${s.pack}\` | ${s.model ?? '—'} | ${s.mode ?? '—'} | ${s.northStar ?? '—'} |`,
    );
  }
  if (!ev.seats.length) lines.push('| _(no summaries)_ | | | | |');
  lines.push('');
  lines.push('## productCandidate (Interwave input)');
  lines.push('');
  if (!ev.productCandidates.length) {
    lines.push('_None stamped — no auto product claims from this run._');
  } else {
    lines.push('| Seat | Task | Verdict | Pack |');
    lines.push('|------|------|---------|------|');
    for (const p of ev.productCandidates) {
      lines.push(`| ${p.seat} | ${p.taskId} | ${p.verdict ?? '—'} | \`${p.pack}\` |`);
    }
  }
  lines.push('');
  lines.push('## Run report');
  lines.push('');
  if (ev.report) {
    lines.push(`- concurrency: ${ev.report.concurrency ?? ev.report.parallel ?? '—'}`);
    lines.push(`- ok: ${ev.report.ok}`);
    lines.push(`- freezeHash: \`${ev.report.freezeHash || '—'}\``);
  } else {
    lines.push('_No wave2-run-report.json_');
  }
  lines.push('');
  lines.push('## Law reminder');
  lines.push('');
  lines.push('Scoreboard alone does not complete a wave — need product compound or owner deferral.');
  lines.push('See `docs/agent-law/wave-gate-dream-cycle.md`.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderSynthesisMarkdown(ev, { wave, tip }) {
  const lines = [];
  lines.push(`# Wave ${wave} — Auto synthesis (draft)`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Tip:** \`${tip || 'unknown'}\``);
  lines.push('**Status:** draft — promote durable doctrine only from observed patterns');
  lines.push('');
  lines.push('## Observed');
  lines.push('');
  const live = ev.seats.filter((s) => s.mode === 'live');
  const partial = ev.seats.filter((s) => s.mode && s.mode !== 'live');
  lines.push(`- Live packs: **${live.length}** · non-live/partial: **${partial.length}**`);
  lines.push(`- productCandidate count: **${ev.productCandidates.length}**`);
  for (const s of live) {
    lines.push(`- [${s.seat}] mode=live NS=${s.northStar ?? 'null'} model=${s.model}`);
  }
  lines.push('');
  lines.push('## Product vs instrumentation');
  lines.push('');
  lines.push('| Kind | Signal |');
  lines.push('|------|--------|');
  lines.push(`| product | productCandidate tasks (${ev.productCandidates.length}) |`);
  lines.push('| instrumentation | non-live modes, gapClass (see report tool) |');
  lines.push('');
  lines.push('## Model fingerprint (fill after read)');
  lines.push('');
  lines.push('_How did this wave’s brains improve Sinter?_ — operator completes after Interwave.');
  lines.push('');
  lines.push('## Dispositions');
  lines.push('');
  for (const p of ev.productCandidates) {
    lines.push(`- **${p.taskId}** (${p.seat}): queued Interwave (auto-claim)`);
  }
  if (!ev.productCandidates.length) {
    lines.push('- No productCandidate — empty Interwave only if owner accepts.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function renderDreamsMarkdown(ev, { wave, freeze }) {
  const w = Number(wave) || 0;
  const next = w + 1;
  const w2 = freeze?.wave2 || freeze?.wave1 || {};
  const lines = [];
  lines.push(`# Wave ${wave} — Dreams (auto draft)`);
  lines.push('');
  lines.push(`**Next wave:** ${next}`);
  lines.push('');
  lines.push('## Speculative experiments');
  lines.push('');
  lines.push('1. Re-verify productCandidate fixes under same fixedJudge.');
  lines.push('2. Domain regression: gen p5-hard latency/tool-loop under Grok.');
  lines.push('3. Evaluator GLM vs W1 K3 planted table (if eval sat GLM).');
  lines.push('4. Parallel contention residual: ledger lock thrash, rate limits.');
  lines.push('');
  lines.push('## Proposed seat map (draft — not applied)');
  lines.push('');
  lines.push('Latin-style rotate of wave2 (proposal only):');
  lines.push('');
  lines.push('| Seat | Wave2 (current) | Proposed next |');
  lines.push('|------|-----------------|---------------|');
  // simple rotate: harness<-chat, gen stays or cycle brains
  const brains = [w2.harness, w2.generator, w2.evaluator, w2.chat].filter(Boolean);
  const rot = (i) => brains[(i + 1) % Math.max(brains.length, 1)] || 'TBD';
  lines.push(`| harness | ${w2.harness ?? '—'} | ${rot(0)} |`);
  lines.push(`| generator | ${w2.generator ?? '—'} | ${rot(1)} |`);
  lines.push(`| evaluator | ${w2.evaluator ?? '—'} | ${rot(2)} |`);
  lines.push(`| chat | ${w2.chat ?? '—'} | ${rot(3)} |`);
  lines.push('');
  lines.push('Owner must accept freeze proposal before pin flip.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function buildFreezeProposal(freeze, { wave, tip }) {
  const w2 = freeze?.wave2 || {};
  const brains = [w2.harness, w2.generator, w2.evaluator, w2.chat].filter(Boolean);
  const rot = (i) => (brains.length ? brains[(i + 1) % brains.length] : null);
  return {
    schema: 'sinter-tour-seat-freeze-proposal-v1',
    proposedAt: new Date().toISOString(),
    basedOnTip: tip,
    fromWave: wave,
    toWave: Number(wave) + 1,
    note: 'PROPOSAL ONLY — apply with LIMINAL_APPLY_FREEZE=1 --apply-freeze',
    current: freeze?.wave2 || null,
    proposed: {
      harness: rot(0),
      generator: rot(1),
      evaluator: rot(2),
      chat: rot(3),
    },
    fixedJudge: freeze?.fixedJudge || null,
  };
}

export function buildPriors(ev, { wave, tip }) {
  return {
    schema: 'sinter-wave-priors-v1',
    wave,
    tip,
    generatedAt: new Date().toISOString(),
    policy: {
      // next run should bias attention; not hard fail
      watchDomains: ['p5'],
      productCandidateTaskIds: ev.productCandidates.map((p) => p.taskId),
      requireLiveModeForFit: true,
      banClaimTagRateAlone: true,
      fixedJudgeRouteRequired: 'agy-cliproxy',
    },
    seatHints: Object.fromEntries(
      ev.seats.map((s) => [
        s.seat,
        { lastMode: s.mode, lastNorthStar: s.northStar, model: s.model },
      ]),
    ),
    learningsRefs: [
      'docs/agents/learnings-2026-07.md',
      'docs/agent-law/wave-gate-dream-cycle.md',
      'docs/agents/waves/mece-wave-gate-alignment.md',
    ],
  };
}

export function buildInterwaveQueue(ev, { wave }) {
  const lines = [];
  lines.push(`# Interwave queue — after wave ${wave}`);
  lines.push('');
  lines.push('**Auto-generated.** Implement via Grok/orchestrator → GLM MERGE. Do not auto-merge.');
  lines.push('');
  if (!ev.productCandidates.length) {
    lines.push('_Empty productCandidate set._');
    return `${lines.join('\n')}\n`;
  }
  lines.push('| # | Claim seed | Seat | Task | Brief |');
  lines.push('|---|------------|------|------|-------|');
  ev.productCandidates.forEach((p, i) => {
    lines.push(
      `| ${i + 1} | W${wave}-PC-${p.taskId} | ${p.seat} | ${p.taskId} | Fix product fail from pack \`${p.pack}\`; verified edit + tests |`,
    );
  });
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Open claims for product candidates; idempotent by fingerprint.
 */
export function openProductCandidateClaims(ev, {
  wave,
  tip,
  ledgerPath = DEFAULT_CLAIM_LEDGER,
  dryRun = false,
} = {}) {
  const ledger = readClaimLedger(ledgerPath);
  const opened = [];
  const skipped = [];

  for (const p of ev.productCandidates) {
    const title = `productCandidate: ${p.taskId} (${p.seat})`;
    const fingerprint = claimFingerprint({
      title,
      seat: p.seat,
      pathHints: [p.taskId, p.pack],
    });
    const existing = (ledger.claims || []).find(
      (c) => c.fingerprint === fingerprint || c.id === `W${wave}-PC-${p.taskId}`,
    );
    if (existing && ['open', 'requeue', 'deferred', 'merged'].includes(existing.status)) {
      skipped.push({ taskId: p.taskId, reason: 'exists', id: existing.id, status: existing.status });
      continue;
    }
    const id = `W${wave}-PC-${String(p.taskId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48)}`;
    const claim = {
      id,
      fingerprint,
      title,
      tag: 'product',
      status: 'open',
      wave: Number(wave) || wave,
      priority: 'P1',
      seat: p.seat,
      model: p.model,
      source: 'outer-meta-loop/productCandidate',
      pack: p.pack,
      updatedAt: new Date().toISOString(),
      disposition: 'interwave-queue',
      note: `Auto-opened from stamp productCandidate. Verdict=${p.verdict ?? 'n/a'}`,
    };
    if (!dryRun) {
      if (!Array.isArray(ledger.claims)) ledger.claims = [];
      const idx = ledger.claims.findIndex((c) => c.id === id);
      if (idx >= 0) ledger.claims[idx] = { ...ledger.claims[idx], ...claim };
      else ledger.claims.push(claim);
    }
    opened.push(claim);
  }

  if (!dryRun && opened.length) {
    ledger.notes = `${ledger.notes || ''} Outer-meta opened ${opened.length} productCandidate claims (wave ${wave}).`.trim();
    fsSync.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    for (const c of opened) {
      appendClaimLifecycle({
        action: 'open',
        claimId: c.id,
        fingerprint: c.fingerprint,
        seat: c.seat,
        model: c.model,
        wave,
        tip,
        detail: c.note,
        ledgerPath,
      });
    }
  }

  return { opened, skipped, ledgerPath };
}

export function applyFreezeProposal(proposal, freezePath = FREEZE_PATH) {
  if (process.env.LIMINAL_APPLY_FREEZE !== '1') {
    throw new Error('Refusing freeze apply: set LIMINAL_APPLY_FREEZE=1');
  }
  const freeze = loadJsonSafe(freezePath) || {};
  const nextWave = proposal.toWave || 3;
  freeze[`wave${nextWave}`] = proposal.proposed;
  freeze.pinnedAt = new Date().toISOString();
  freeze.notes = `${freeze.notes || ''} Applied proposal from outer-meta ${proposal.proposedAt}.`.trim();
  fsSync.writeFileSync(freezePath, `${JSON.stringify(freeze, null, 2)}\n`, 'utf8');
  return freezePath;
}

/**
 * Full outer-meta pass.
 */
export async function runOuterMetaLoop(opts) {
  const args = typeof opts.stampDir === 'string' || opts.wave != null
    ? opts
    : parseArgs(opts.argv || process.argv.slice(2));

  let stampDir = args.stampDir;
  if (!stampDir && args.latest && args.wave) {
    stampDir = resolveLatestStampDir(args.wave);
  }
  if (!stampDir) {
    throw new Error('Need --stamp-dir PATH or --wave N --latest');
  }

  const stamp = path.basename(stampDir);
  const wave = args.wave
    || (stampDir.includes('wave-')
      ? (stampDir.match(/wave-(\d+)/) || [])[1]
      : '2');
  const tip = resolveGitTip();
  const freeze = loadJsonSafe(FREEZE_PATH) || {};
  const ev = extractStampEvidence(stampDir);

  const artifacts = {
    stampDir,
    wave,
    tip,
    harvestPath: null,
    synthesisPath: null,
    dreamsPath: null,
    freezeProposalPath: null,
    priorsPath: null,
    queuePath: null,
    claims: null,
  };

  const metaDir = path.join(stampDir, 'outer-meta');
  if (!args.dryRun) fsSync.mkdirSync(metaDir, { recursive: true });

  if (args.applyDocs && !args.dryRun) {
    const harvest = renderHarvestMarkdown(ev, { wave, tip, stamp });
    const synthesis = renderSynthesisMarkdown(ev, { wave, tip });
    const dreams = renderDreamsMarkdown(ev, { wave, freeze });
    const queue = buildInterwaveQueue(ev, { wave });

    artifacts.harvestPath = path.join(metaDir, 'harvest.md');
    artifacts.synthesisPath = path.join(metaDir, 'synthesis.md');
    artifacts.dreamsPath = path.join(metaDir, 'dreams.md');
    artifacts.queuePath = path.join(metaDir, 'INTERWAVE_QUEUE.md');

    fsSync.writeFileSync(artifacts.harvestPath, harvest);
    fsSync.writeFileSync(artifacts.synthesisPath, synthesis);
    fsSync.writeFileSync(artifacts.dreamsPath, dreams);
    fsSync.writeFileSync(artifacts.queuePath, queue);

    // Also mirror under docs/agents/waves for operator discovery
    const docHarvest = path.join(DOCS_WAVES, `wave-${wave}-auto-harvest.md`);
    const docSynth = path.join(DOCS_WAVES, `wave-${wave}-auto-synthesis.md`);
    const docDream = path.join(DOCS_WAVES, `wave-${wave}-auto-dreams.md`);
    fsSync.writeFileSync(docHarvest, harvest);
    fsSync.writeFileSync(docSynth, synthesis);
    fsSync.writeFileSync(docDream, dreams);

    const proposal = buildFreezeProposal(freeze, { wave, tip });
    artifacts.freezeProposalPath = path.join(metaDir, 'tour-seat-live-freeze.PROPOSED.json');
    fsSync.writeFileSync(artifacts.freezeProposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
    fsSync.writeFileSync(
      path.join(DOCS_WAVES, `tour-seat-live-freeze.PROPOSED-wave-${wave}.json`),
      `${JSON.stringify(proposal, null, 2)}\n`,
    );

    if (args.applyFreeze) {
      applyFreezeProposal(proposal);
    }
  }

  if (args.applyPriors && !args.dryRun) {
    const priors = buildPriors(ev, { wave, tip });
    artifacts.priorsPath = path.join(metaDir, 'wave-priors.json');
    fsSync.writeFileSync(artifacts.priorsPath, `${JSON.stringify(priors, null, 2)}\n`);
    // pointer for next run
    const pointer = path.join(REPO, '.quality', 'tour', `wave-${wave}`, 'LATEST_PRIORS.json');
    fsSync.mkdirSync(path.dirname(pointer), { recursive: true });
    fsSync.writeFileSync(
      pointer,
      `${JSON.stringify({ path: artifacts.priorsPath, wave, tip, at: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  if (args.applyClaims) {
    artifacts.claims = openProductCandidateClaims(ev, {
      wave,
      tip,
      dryRun: args.dryRun,
    });
  }

  const summary = {
    schema: 'sinter-outer-meta-result-v1',
    wave,
    tip,
    stampDir,
    productCandidateCount: ev.productCandidates.length,
    seatCount: ev.seats.length,
    artifacts,
    claimsOpened: artifacts.claims?.opened?.length ?? 0,
    claimsSkipped: artifacts.claims?.skipped?.length ?? 0,
  };

  if (!args.dryRun) {
    fsSync.writeFileSync(
      path.join(metaDir, 'outer-meta-result.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOuterMetaLoop(args);
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('outer-meta-loop.mjs');
if (isMain) {
  main().catch((err) => {
    console.error('[outer-meta-loop] FATAL', err);
    process.exit(1);
  });
}
