import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  WAVE6_LANE_DEFINITIONS,
  aggregateWave6LaneReceipts,
  hasCompleteWave6Evidence,
} from '../../dist/quality/Wave6CreativeFlywheel.js';

const repoRoot = process.cwd();
const receiptRoot = path.resolve('docs/agents/waves/receipts');
const lanes = Object.keys(WAVE6_LANE_DEFINITIONS);
const exec = promisify(execFile);
const receiptArgs = process.argv.slice(2).flatMap((arg, index, args) =>
  arg === '--receipt' && args[index + 1] ? [args[index + 1]] : []);
if (receiptArgs.length !== lanes.length) {
  process.stderr.write('Wave 6 close gate requires three explicit --receipt paths\n');
  process.exit(2);
}
const currentHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();

async function loadReceipt(inputPath) {
  const receiptPath = path.resolve(repoRoot, inputPath);
  if (path.dirname(receiptPath) !== receiptRoot) {
    throw new Error(`Receipt must be inside ${path.relative(repoRoot, receiptRoot)}`);
  }
  return {
    receiptPath,
    receipt: JSON.parse(await fs.readFile(receiptPath, 'utf8')),
  };
}

const selected = [];
try {
  for (const receiptPath of receiptArgs) selected.push(await loadReceipt(receiptPath));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const integrityFailures = [];
for (const { receipt } of selected) {
  if (receipt.evidence?.strictReviewVerdict?.startsWith('INVALIDATED_')) {
    integrityFailures.push(
      `${receipt.lane}: ${receipt.evidence.strictReviewVerdict}`,
    );
  }
  if (receipt.lane !== receipt.gate?.replace('W6-', '')) {
    integrityFailures.push(`${receipt.lane}: gate/lane mismatch`);
  }
  if (['PASS', 'PENDING_OWNER'].includes(receipt.status)) {
    if (!hasCompleteWave6Evidence(receipt.evidenceRefs, receipt.evidenceDigests)) {
      integrityFailures.push(`${receipt.lane}: incomplete formal evidence set`);
    }
    if (receipt.candidateRef !== currentHead) {
      integrityFailures.push(`${receipt.lane}: receipt is not bound to current HEAD`);
    }
    if (!/^[a-f0-9]{40}$/.test(receipt.controlRef ?? '')) {
      integrityFailures.push(`${receipt.lane}: invalid control ref`);
    }
    if (!/^[a-f0-9]{64}$/.test(receipt.recipeDigest ?? '')) {
      integrityFailures.push(`${receipt.lane}: invalid recipe digest`);
    }
    const refs = [
      ...(receipt.evidenceRefs?.formalArtifacts ?? []),
      ...(receipt.evidenceRefs?.screenshots ?? []),
      ...(receipt.evidenceRefs?.media ?? []),
    ];
    for (const ref of refs) {
      try {
        const content = await fs.readFile(path.resolve(repoRoot, ref));
        const digest = createHash('sha256').update(content).digest('hex');
        if (receipt.evidenceDigests?.[ref] !== digest) {
          integrityFailures.push(`${receipt.lane}: evidence digest mismatch ${ref}`);
        }
      } catch {
        integrityFailures.push(`${receipt.lane}: missing ${ref}`);
      }
    }
    for (const ref of receipt.evidenceRefs?.formalArtifacts ?? []) {
      const html = await fs.readFile(path.resolve(repoRoot, ref), 'utf8').catch(() => '');
      if (!html.includes(`data-wave6-recipe-digest="${receipt.recipeDigest}"`)) {
        integrityFailures.push(`${receipt.lane}: artifact digest mismatch ${ref}`);
      }
    }
    if (receipt.creativeProof?.outcome !== 'PASS'
      || receipt.result?.checks?.creativeProof !== true) {
      integrityFailures.push(`${receipt.lane}: creative proof did not pass`);
    }
    if (receipt.cortex?.checkpoint?.state !== 'completed'
      || receipt.result?.checks?.cortex !== true) {
      integrityFailures.push(`${receipt.lane}: Cortex cycle did not complete`);
    }
  }
}

let aggregate;
try {
  aggregate = aggregateWave6LaneReceipts(selected.map(({ receipt }) => ({
    lane: receipt.lane,
    status: receipt.status,
    recipeDigest: receipt.recipeDigest ?? '',
  })));
} catch (error) {
  integrityFailures.push(error.message);
  aggregate = {
    status: 'FAIL',
    byLane: Object.fromEntries(selected.map(({ receipt }) => [receipt.lane, receipt.status])),
  };
}
if (integrityFailures.length > 0) aggregate.status = 'FAIL';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const galleryRoot = path.resolve('.quality', 'tour', 'wave-6');
const contactSheetPath = path.join(galleryRoot, `wave-6-contact-sheet-${stamp}.html`);
const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const galleryRef = ref =>
  path.relative(galleryRoot, path.resolve(repoRoot, ref));
const imageTag = (ref, label, artifactRef, mediaRef) => {
  const source = path.relative(galleryRoot, path.resolve(repoRoot, ref));
  const image = `<img src="${escapeHtml(source)}" alt="${escapeHtml(label)}">`;
  const linked = artifactRef
    ? `<a href="${escapeHtml(galleryRef(artifactRef))}">${image}</a>`
    : image;
  const media = mediaRef
    ? ` · <a href="${escapeHtml(galleryRef(mediaRef))}">play recorded proof</a>`
    : '';
  const playable = artifactRef
    ? ` · <a href="${escapeHtml(galleryRef(artifactRef))}">open interactive artifact</a>`
    : '';
  return `<figure>${linked}<figcaption>${escapeHtml(label)}${playable}${media}</figcaption></figure>`;
};
const sections = selected.map(({ receipt }) => {
  const images = [];
  for (const pair of receipt.formalPairs ?? []) {
    const control = receipt.evidenceRefs?.screenshots?.find(ref => ref.endsWith(`C${pair.trialId}.png`));
    const treatment = receipt.evidenceRefs?.screenshots?.find(ref => ref.endsWith(`T${pair.trialId}.png`));
    if (!control || !treatment) continue;
    const a = pair.controlShownAs === 'A' ? control : treatment;
    const b = pair.controlShownAs === 'A' ? treatment : control;
    const aLabel = pair.controlShownAs === 'A' ? pair.control : pair.treatment;
    const bLabel = pair.controlShownAs === 'A' ? pair.treatment : pair.control;
    const artifact = label => receipt.evidenceRefs?.formalArtifacts
      ?.find(ref => ref.endsWith(`/${label}.html`));
    const media = label => receipt.evidenceRefs?.media
      ?.find(ref => ref.endsWith(`/${label}.webm`));
    images.push(imageTag(a, `Trial ${pair.trialId} — Artifact A`, artifact(aLabel), media(aLabel)));
    images.push(imageTag(b, `Trial ${pair.trialId} — Artifact B`, artifact(bLabel), media(bLabel)));
  }
  return `<section>
    <h2>${escapeHtml(receipt.lane)} <span class="status">${escapeHtml(receipt.status)}</span></h2>
    <p>${escapeHtml(receipt.definition?.brief)}</p>
    <p>Mean paired effect: ${Number(receipt.result?.meanEffect ?? 0).toFixed(3)} · owner trial: ${escapeHtml(receipt.result?.ownerPairTrialId ?? 'n/a')}</p>
    <div class="grid">${images.join('')}</div>
  </section>`;
}).join('\n');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Wave 6 output contact sheet</title>
<style>body{background:#081018;color:#eaf4ff;font:16px system-ui;margin:0;padding:32px}h1,h2{letter-spacing:.02em}.status{font-size:.65em;color:#8bd3ff}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;background:#101c29;padding:10px;border-radius:12px}img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#000}figcaption{padding:8px 2px 2px;color:#b7c9d8}section{margin:40px 0 64px}@media(max-width:800px){.grid{grid-template-columns:1fr}}</style>
</head><body><h1>Wave 6 output contact sheet</h1><p>Aggregate: ${escapeHtml(aggregate.status)}. Arm identity remains hidden while owner gates are pending.</p>${sections}</body></html>`;
await fs.mkdir(galleryRoot, { recursive: true });
await fs.writeFile(contactSheetPath, html);

const closeReceipt = {
  schemaVersion: 1,
  gate: 'W6-CLOSE',
  generatedAt: new Date().toISOString(),
  status: aggregate.status,
  byLane: aggregate.byLane,
  integrityFailures,
  laneReceipts: selected.map(({ receiptPath }) => path.relative(repoRoot, receiptPath)),
  contactSheet: path.relative(repoRoot, contactSheetPath),
  ownerGates: selected
    .filter(({ receipt }) => receipt.status === 'PENDING_OWNER')
    .map(({ receipt }) => ({
      lane: receipt.lane,
      trialId: receipt.result?.ownerPairTrialId,
      controlScreenshot: receipt.ownerReview?.controlScreenshot,
      treatmentScreenshot: receipt.ownerReview?.treatmentScreenshot,
      labelsHidden: true,
    })),
  mergeAllowed: false,
};
const closeReceiptPath = path.join(receiptRoot, 'wave-6-closeout.json');
await fs.writeFile(closeReceiptPath, `${JSON.stringify(closeReceipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  status: closeReceipt.status,
  byLane: closeReceipt.byLane,
  integrityFailures,
  contactSheet: closeReceipt.contactSheet,
  closeReceipt: path.relative(repoRoot, closeReceiptPath),
}, null, 2)}\n`);
process.exit(closeReceipt.status === 'PASS' ? 0 : closeReceipt.status === 'FAIL' ? 1 : 2);
