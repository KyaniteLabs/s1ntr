import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  createMemoryFeedForwardGateReceipt,
  type MemoryFeedForwardCondition,
} from '../../src/runtime-core/Wave5GateReceipt.js';
import {
  migrateStudioLineageRecord,
  type StudioLineageRecord,
} from '../../src/tui-bridge/StudioLineage.js';

const url = process.env.GUI_URL ?? 'http://localhost:5673';
const ledgerPath = process.env.SINTER_STUDIO_LINEAGE_PATH
  ?? path.join(process.cwd(), '.omx', 'lineage', 'studio-lineage.jsonl');
const prompt = process.env.STUDIO_PROMPT
  ?? 'Create a p5.js sketch of pale blue tidal rings orbiting one amber seed; use slow breathing motion and leave a short code comment naming the motion rule.';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(process.cwd(), '.omx', 'proof', `wave5-memory-feed-forward-${stamp}`);
await fs.mkdir(outDir, { recursive: true });

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readRecords(): Promise<StudioLineageRecord[]> {
  try {
    const text = await fs.readFile(ledgerPath, 'utf8');
    return text.split('\n').filter(Boolean).map((line) =>
      migrateStudioLineageRecord(JSON.parse(line))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readPreview(page: Page): Promise<{
  ready: boolean;
  error: boolean;
  artifactDigest: string;
}> {
  const state = await page.evaluate(() => {
    const iframe = document.querySelector('.sinter-preview-panel iframe');
    const srcdoc = iframe?.getAttribute('srcdoc') ?? '';
    const body = document.body.innerText;
    return {
      srcdoc,
      ready: Boolean(iframe) && /createCanvas|p5\.min\.js/i.test(srcdoc),
      error: /Preview unavailable|generation failed|disconnected/i.test(body),
    };
  });
  return {
    ready: state.ready,
    error: state.error,
    artifactDigest: sha256(state.srcdoc),
  };
}

async function waitForCondition(
  page: Page,
  sessionId: () => string | undefined,
  existingRecordIds: Set<string>,
): Promise<{ preview: Awaited<ReturnType<typeof readPreview>>; records: StudioLineageRecord[] }> {
  const deadline = Date.now() + 330_000;
  let preview = await readPreview(page);
  while (Date.now() < deadline) {
    preview = await readPreview(page);
    const id = sessionId();
    const records = (await readRecords()).filter((record) =>
      !existingRecordIds.has(record.recordId) && record.sessionId === id
    );
    const request = records.find((record) => record.origin === 'studio-generator-request');
    const writeBack = records.find((record) =>
      record.origin === 'cognitive-memory'
      && record.payload.phase === 'write-back'
      && typeof record.payload.episodeId === 'string'
    );
    if (preview.ready && !preview.error && request && writeBack) {
      return { preview, records };
    }
    if (preview.error) throw new Error(`Studio reported a generation error for ${id ?? 'unknown session'}`);
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Timed out waiting for preview and lineage write-back for ${sessionId() ?? 'unknown session'}`);
}

function conditionFrom(
  sessionId: string,
  preview: Awaited<ReturnType<typeof readPreview>>,
  records: StudioLineageRecord[],
): MemoryFeedForwardCondition {
  const request = records.find((record) => record.origin === 'studio-generator-request');
  if (!request) throw new Error(`Missing generator request receipt for ${sessionId}`);
  return {
    lineageId: request.lineageId,
    sessionId,
    contextDigest: String(request.payload.contextDigest ?? ''),
    requestDigest: String(request.payload.requestDigest ?? ''),
    artifactDigest: preview.artifactDigest,
    injected: request.payload.injected === true,
    sourceEpisodeIds: Array.isArray(request.payload.sourceEpisodeIds)
      ? request.payload.sourceEpisodeIds.map(String)
      : [],
    tainted: request.taint === 'tainted',
  };
}

async function runCondition(
  label: 'control' | 'treatment',
  existingRecordIds: Set<string>,
): Promise<{
  condition: MemoryFeedForwardCondition;
  episodeId: string;
  digestStamped: boolean;
  recordIds: string[];
}> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  let submittedSessionId: string | undefined;
  let hasPriorRunReceipt = false;
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !/\/api\/tui\/session\/[^/]+\/input$/.test(request.url())) return;
    const body = request.postDataJSON() as { creativePreferences?: { priorRunReceipt?: unknown } };
    submittedSessionId = request.url().match(/\/session\/([^/]+)\/input$/)?.[1];
    hasPriorRunReceipt = Boolean(body.creativePreferences?.priorRunReceipt);
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('.sinter-workbench', { timeout: 30_000 });
    await page.fill('#workbench-prompt', prompt);
    await page.click('.sinter-run-button');
    const result = await waitForCondition(page, () => submittedSessionId, existingRecordIds);
    await page.screenshot({ path: path.join(outDir, `${label}.png`), fullPage: true });
    if (!submittedSessionId) throw new Error(`${label} submission session was not captured`);
    if (hasPriorRunReceipt) throw new Error(`${label} was confounded by a prior-run revision receipt`);
    const request = result.records.find((record) => record.origin === 'studio-generator-request');
    const writeBack = result.records.find((record) =>
      record.origin === 'cognitive-memory' && typeof record.payload.episodeId === 'string'
    );
    if (!request || !writeBack) throw new Error(`${label} lineage receipts are incomplete`);
    return {
      condition: conditionFrom(submittedSessionId, result.preview, result.records),
      episodeId: String(writeBack.payload.episodeId),
      digestStamped: request.payload.digestStamped === true,
      recordIds: result.records.map((record) => record.recordId),
    };
  } finally {
    await context.close();
  }
}

const before = await readRecords();
const existingRecordIds = new Set(before.map((record) => record.recordId));
const browser = await chromium.launch({ headless: true });
try {
  const control = await runCondition('control', existingRecordIds);
  control.recordIds.forEach((recordId) => existingRecordIds.add(recordId));
  const treatment = await runCondition('treatment', existingRecordIds);
  const receipt = createMemoryFeedForwardGateReceipt({
    generatedAt: new Date().toISOString(),
    promptDigest: sha256(prompt),
    control: control.condition,
    treatment: treatment.condition,
    checks: {
      controlUninjected: !control.condition.injected && control.condition.sourceEpisodeIds.length === 0,
      treatmentInjected: treatment.condition.injected && treatment.condition.sourceEpisodeIds.length > 0,
      exactDigestStamped: control.digestStamped && treatment.digestStamped,
      sourceLinked: treatment.condition.sourceEpisodeIds.includes(control.episodeId),
      requestChanged: control.condition.requestDigest !== treatment.condition.requestDigest,
      downstreamChanged: control.condition.artifactDigest !== treatment.condition.artifactDigest,
      taintPreserved: !control.condition.tainted && treatment.condition.tainted,
    },
    evidenceRefs: [
      `lineage:${control.condition.lineageId}`,
      `lineage:${treatment.condition.lineageId}`,
      `episode:${control.episodeId}`,
    ],
  });
  await fs.writeFile(path.join(outDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outDir, ...receipt }, null, 2)}\n`);
  if (receipt.outcome !== 'PASS') process.exitCode = 1;
} finally {
  await browser.close();
}
