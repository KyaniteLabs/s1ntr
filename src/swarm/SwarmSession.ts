/**
 * Durable swarm session records (`liminal.swarm-session.v1`).
 *
 * `SwarmOrchestrator` already wrote `evolution_<id>.json` into `streamDir`,
 * but that legacy stream file has no prompt, no stable session id, and no
 * candidate artifacts — so a human could not label a run later. This module
 * builds and persists the complete, blind-labelable record plus the final
 * round's candidate sources.
 *
 * One JSON file per run: `<sessionDir>/<sessionId>.json`.
 * Candidate sources:    `<sessionDir>/<sessionId>/candidates/candidate-<n>.<ext>`.
 *
 * Writes are atomic (`writeFileAtomic`) so a crash never leaves a partially
 * written session that the `label` command would misread.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CodeValidator } from '../core/CodeValidator.js';
import { writeFileAtomic } from '../utils/atomicWrite.js';
import { VotingEngine } from './VotingEngine.js';
import type { RoundResult, SwarmResult, VoteSource } from './types.js';

export const SWARM_SESSION_SCHEMA = 'liminal.swarm-session.v1';

export interface SwarmSessionCandidate {
  /** 1-based display index; the only handle a blind pick uses. */
  index: number;
  personaId: string;
  personaName: string;
  model: string;
  lines: number;
  sourcePath: string;
  previewPath?: string;
}

export interface SwarmSessionOutput {
  content: string;
  model: string;
  personaName: string;
}

export interface SwarmSessionVote {
  firstChoice: string;
  secondChoice: string;
  reasoning: string;
  /** Absent on records written before vote sources were captured. */
  voteSource?: VoteSource;
}

export interface SwarmSessionRound {
  roundNum: number;
  outputs: Record<string, SwarmSessionOutput>;
  votes: Record<string, SwarmSessionVote>;
  scores: Record<string, number>;
  winnerId: string | null;
}

export interface SwarmSessionLabel {
  source: 'human';
  goldWinner: string;
  outcomeId: string;
  labelledAt: string;
  recordedVotes: number;
  recordedVoters: string[];
  /**
   * Votes kept in the record but excluded from calibration because they are
   * heuristic self-votes or fallback placeholders. Absent when none were skipped.
   */
  skippedSyntheticVotes?: number;
}

export interface SwarmSessionRecord {
  schema: typeof SWARM_SESSION_SCHEMA;
  sessionId: string;
  createdAt: string;
  /** Exact prompt; required. Legacy records without it are refused by `label`. */
  prompt: string;
  /** `VotingEngine.inferDomain(prompt)` frozen at run time. */
  domain: string;
  mode: string;
  converged: boolean;
  convergenceRound: number | null;
  panel: Array<{ personaId: string; model: string }>;
  /** Final round only, display order, empty/error outputs excluded. */
  candidates: SwarmSessionCandidate[];
  rounds: SwarmSessionRound[];
  finalOutput: string;
  /** Absent until a human picks. */
  label?: SwarmSessionLabel;
}

export interface BuildSessionRecordInput {
  result: SwarmResult;
  prompt: string;
  sessionId: string;
  sessionDir: string;
  createdAt?: Date;
}

/** `YYYYMMDDTHHMMSSZ-<6 hex>` — UTC second plus a random suffix. */
export function createSessionId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Domain `CodeValidator` assigns to this output (defaults to p5 for plain JS). */
export function candidateDomain(code: string): string {
  return CodeValidator.detectDomain(code);
}

/** `.svg` for vector output, `.txt` for ascii/textgen, `.js` for everything else. */
export function candidateExtension(code: string): string {
  const domain = candidateDomain(code);
  if (domain === 'svg') return '.svg';
  if (domain === 'ascii' || domain === 'textgen') return '.txt';
  return '.js';
}

/** True when the output can be wrapped into a browser-runnable HTML preview. */
export function isP5Renderable(code: string): boolean {
  return candidateDomain(code) === 'p5';
}

function isErrorOutput(content: string): boolean {
  return content.trim().length === 0 || content.startsWith('[Generation error');
}

/**
 * Final-round candidates in display order. Persona names stay *inside* the
 * record for the after-the-pick reveal; display only ever uses `index` and
 * paths, never the persona fields before the pick.
 */
export function buildCandidates(
  result: SwarmResult,
  sessionDir: string,
  sessionId: string,
): SwarmSessionCandidate[] {
  const finalRound: RoundResult | undefined = result.rounds[result.rounds.length - 1];
  if (!finalRound) return [];
  const candidatesDir = candidateDir(sessionDir, sessionId);
  const candidates: SwarmSessionCandidate[] = [];
  for (const output of finalRound.outputs.values()) {
    if (isErrorOutput(output.content)) continue;
    const index = candidates.length + 1;
    candidates.push({
      index,
      personaId: output.personaId,
      personaName: output.personaName,
      model: output.model,
      lines: output.content.split('\n').length,
      sourcePath: path.join(candidatesDir, `candidate-${index}${candidateExtension(output.content)}`),
    });
  }
  return candidates;
}

function serializeRound(round: RoundResult): SwarmSessionRound {
  return {
    roundNum: round.roundNum,
    outputs: Object.fromEntries(
      [...round.outputs.entries()].map(([id, out]) => [id, {
        content: out.content,
        model: out.model,
        personaName: out.personaName,
      }]),
    ),
    votes: Object.fromEntries(
      [...round.votes.entries()].map(([id, vote]) => [id, {
        firstChoice: vote.firstChoice,
        secondChoice: vote.secondChoice,
        reasoning: vote.reasoning,
        ...(vote.voteSource ? { voteSource: vote.voteSource } : {}),
      }]),
    ),
    scores: Object.fromEntries(round.scores.entries()),
    winnerId: round.winnerId,
  };
}

/**
 * Recover a vote's source for records written before `voteSource` existed.
 *
 * Heuristic self-votes are distinguishable by construction: the voter picks
 * its own candidate and the reasoning is the scorer's `Heuristic …` line. The
 * no-caller placeholder says `Fallback vote …`. Anything else was a parsed
 * vote and counts as a real LLM vote (the conservative, backwards-compatible
 * reading: legacy records keep calibrating).
 */
export function inferVoteSource(
  voterId: string,
  vote: Pick<SwarmSessionVote, 'firstChoice' | 'reasoning'>,
): VoteSource {
  if (vote.firstChoice === voterId && vote.reasoning.startsWith('Heuristic ')) return 'heuristic';
  if (vote.reasoning.startsWith('Fallback vote')) return 'fallback';
  return 'llm';
}

/** Pure builder — no filesystem access; `sourcePath` values are the intended locations. */
export function buildSwarmSessionRecord(input: BuildSessionRecordInput): SwarmSessionRecord {
  const createdAt = input.createdAt ?? new Date();
  const prompt = input.prompt;
  return {
    schema: SWARM_SESSION_SCHEMA,
    sessionId: input.sessionId,
    createdAt: createdAt.toISOString(),
    prompt,
    domain: VotingEngine.inferDomain(prompt),
    mode: String(input.result.mode),
    converged: input.result.converged,
    convergenceRound: input.result.convergenceRound,
    panel: input.result.panelAssignment ?? [],
    candidates: buildCandidates(input.result, input.sessionDir, input.sessionId),
    rounds: input.result.rounds.map(serializeRound),
    finalOutput: input.result.finalOutput,
  };
}

export function candidateDir(sessionDir: string, sessionId: string): string {
  return path.join(path.resolve(sessionDir), sessionId, 'candidates');
}

export function sessionFilePath(sessionDir: string, sessionId: string): string {
  return path.join(path.resolve(sessionDir), `${sessionId}.json`);
}

export interface WriteSessionDeps {
  /** Test seam for the HTML preview export; defaults to `Exporter.exportHTML`. */
  exportHtml?: (code: string, outputPath: string) => Promise<void>;
}

export interface WriteSessionResult {
  record: SwarmSessionRecord;
  sessionPath: string;
}

/**
 * Persist candidate sources first, then the record. Preview export is
 * best-effort: a failure records the source path only and never blocks a run.
 */
export async function writeSwarmSession(
  result: SwarmResult,
  prompt: string,
  sessionDir: string,
  deps: WriteSessionDeps = {},
): Promise<WriteSessionResult> {
  const createdAt = new Date();
  const sessionId = createSessionId(createdAt);
  const record = buildSwarmSessionRecord({ result, prompt, sessionId, sessionDir, createdAt });
  const finalRound = result.rounds[result.rounds.length - 1];
  const candidatesDir = candidateDir(sessionDir, sessionId);
  await mkdir(candidatesDir, { recursive: true });

  // Re-walk the final round alongside the candidate list so content and
  // metadata stay in the same display order without duplicating the filter.
  const viableOutputs = finalRound
    ? [...finalRound.outputs.values()].filter(output => !isErrorOutput(output.content))
    : [];

  const exportHtml = deps.exportHtml ?? defaultExportHtml;
  for (let i = 0; i < record.candidates.length; i++) {
    const candidate = record.candidates[i];
    const output = viableOutputs[i];
    if (!candidate || !output) continue;
    await writeFile(candidate.sourcePath, output.content, 'utf-8');
    if (isP5Renderable(output.content)) {
      const previewPath = path.join(candidatesDir, `candidate-${candidate.index}.html`);
      try {
        await exportHtml(output.content, previewPath);
        candidate.previewPath = previewPath;
      } catch {
        // Non-fatal: the source path is still saved and printed.
      }
    }
  }

  await mkdir(path.resolve(sessionDir), { recursive: true });
  const sessionPath = sessionFilePath(sessionDir, sessionId);
  await writeFileAtomic(sessionPath, JSON.stringify(record, null, 2));
  return { record, sessionPath };
}

async function defaultExportHtml(code: string, outputPath: string): Promise<void> {
  // Dynamic import keeps the heavy exporter (archiver, render stacks) out of
  // the swarm CLI's startup path and off runs that never need a preview.
  const { Exporter } = await import('../export/Exporter.js');
  await new Exporter().exportHTML(code, outputPath);
}

/** Parse + validate a session file. Throws with a user-facing reason. */
export function parseSwarmSession(raw: unknown, source: string): SwarmSessionRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Session ${source} is not a JSON object`);
  }
  const record = raw as Partial<SwarmSessionRecord>;
  if (record.schema !== SWARM_SESSION_SCHEMA) {
    throw new Error(`Session ${source} is not a ${SWARM_SESSION_SCHEMA} record`);
  }
  if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') {
    throw new Error(`Session ${source} has no sessionId`);
  }
  if (!Array.isArray(record.candidates) || !Array.isArray(record.rounds)) {
    throw new Error(`Session ${source} is missing candidates/rounds`);
  }
  return record as SwarmSessionRecord;
}

export async function loadSwarmSession(sessionDir: string, sessionId: string): Promise<SwarmSessionRecord> {
  const source = sessionFilePath(sessionDir, sessionId);
  let text: string;
  try {
    text = await readFile(source, 'utf-8');
  } catch {
    throw new Error(`Session ${sessionId} not found at ${source}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Session ${source} is not valid JSON: ${(err as Error).message}`);
  }
  return parseSwarmSession(parsed, source);
}

/** Newest first. Unreadable/foreign JSON files are skipped, not fatal. */
export async function listSwarmSessions(sessionDir: string): Promise<SwarmSessionRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(path.resolve(sessionDir));
  } catch {
    return [];
  }
  const records: SwarmSessionRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const text = await readFile(path.join(path.resolve(sessionDir), name), 'utf-8');
      records.push(parseSwarmSession(JSON.parse(text), name));
    } catch {
      // A foreign or half-written file must not hide the readable sessions.
    }
  }
  return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Merge a label block onto the on-disk record (atomic). */
export async function writeSessionLabel(
  sessionDir: string,
  record: SwarmSessionRecord,
  label: SwarmSessionLabel,
): Promise<SwarmSessionRecord> {
  const next: SwarmSessionRecord = { ...record, label };
  await writeFileAtomic(sessionFilePath(sessionDir, record.sessionId), JSON.stringify(next, null, 2));
  return next;
}
