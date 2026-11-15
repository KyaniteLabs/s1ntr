/**
 * Wave 8 product close gate — uses real Wave8ReleaseRoot validators.
 * Exit 0 only when ownerReleaseReady is true with requireCampaignOrigin.
 * Never invents product receipts.
 *
 * Campaign trust (required for product-complete with requireCampaignOrigin):
 *   --campaign-root / env SINTER_WAVE8_CAMPAIGN_ROOT  → campaign-release-root.json
 *   --trust-store   / env SINTER_CAMPAIGN_TRUST_STORE → { keys: [{ keyId, publicKeyPem }] }
 * Colocated defaults under the release dir: campaign-release-root.json + campaign-trust.json
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  parseWave8ReleaseRoot,
  validateWave8ReleaseRoot,
  type Wave8ReleaseRoot,
} from '../../src/runtime-core/Wave8ReleaseRoot.js';
import type { CampaignReleaseRoot } from '../../src/runtime-core/CampaignOrigin.js';
import { computeProofSourceFingerprint, readCurrentGitCommit } from '../../src/runtime-core/ProofReceiptValidator.js';

const PRD_KINDS = [
  'campaign-origin',
  'actual-executor',
  'creative-quality',
  'causal-revision',
  'sealed-transfer',
  'dream-recommendation',
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

function loadCampaign(
  releasePath: string,
): { releaseRoot: CampaignReleaseRoot; trustedKeys: Map<string, string> } | undefined {
  const releaseDir = path.dirname(releasePath);
  const campaignPath = path.resolve(
    arg('--campaign-root')
      ?? process.env.SINTER_WAVE8_CAMPAIGN_ROOT
      ?? path.join(releaseDir, 'campaign-release-root.json'),
  );
  const trustPath = path.resolve(
    arg('--trust-store')
      ?? process.env.SINTER_CAMPAIGN_TRUST_STORE
      ?? path.join(releaseDir, 'campaign-trust.json'),
  );
  if (!existsSync(campaignPath) || !existsSync(trustPath)) return undefined;
  const releaseRoot = JSON.parse(readFileSync(campaignPath, 'utf8')) as CampaignReleaseRoot;
  const trust = JSON.parse(readFileSync(trustPath, 'utf8')) as {
    keys?: { keyId: string; publicKeyPem: string }[];
  };
  return {
    releaseRoot,
    trustedKeys: new Map((trust.keys ?? []).map(key => [key.keyId, key.publicKeyPem])),
  };
}

function validFingerprint(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function main(): void {
  const repoRoot = process.cwd();
  const releasePath = path.resolve(arg('--release-root') ?? '.quality/wave-8/release/release-root.json');
  if (!existsSync(releasePath)) {
    console.error(JSON.stringify({ ok: false, error: 'missing-release-root', releasePath }, null, 2));
    process.exit(2);
  }
  const root: Wave8ReleaseRoot = parseWave8ReleaseRoot(JSON.parse(readFileSync(releasePath, 'utf8')));
  const tip = readCurrentGitCommit(repoRoot);
  const fp = computeProofSourceFingerprint(repoRoot)?.replace(/^sha256:/, '');
  const campaign = loadCampaign(releasePath);
  const report = validateWave8ReleaseRoot(root, {
    currentSourceFingerprint: fp,
    requireCampaignOrigin: true,
    campaign,
  });
  const kinds = root.receipts.map(r => r.kind);
  const prd = Object.fromEntries(PRD_KINDS.map(k => [k, kinds.includes(k)]));
  const prdSixKindsAllPresent = Object.values(prd).every(Boolean);
  const sourceFingerprintMatches = validFingerprint(fp) && fp === root.sourceFingerprint;
  const out = {
    ok: report.ownerReleaseReady === true && prdSixKindsAllPresent
      && tip === root.releaseHead && sourceFingerprintMatches,
    tip,
    releaseHead: root.releaseHead,
    headMatches: tip === root.releaseHead,
    sourceFingerprintMatches,
    releaseRootDigest: root.releaseRootDigest,
    ownerReleaseReady: report.ownerReleaseReady,
    campaignLoaded: Boolean(campaign),
    conjuncts: report.conjuncts.map(c => ({ id: c.id, passed: c.passed, failures: c.failures })),
    blockers: report.blockers,
    prdSixKindsPresent: prd,
    prdSixKindsAllPresent,
    note: 'ownerReleaseReady requires governed-product receipts + PRD six kinds + trusted campaign origin; diagnostic UltraQA alone cannot green product.',
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

main();
