/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * `sinter swarm` — operator CLI for swarm runs and human gold labels.
 *
 * Verbs:
 *   run       run a swarm, persist a `liminal.swarm-session.v1` record, offer a blind pick
 *   sessions  list recorded sessions (newest first)
 *   label     blind-pick the correct final output for an existing session and write the
 *             `liminal.voting-calibration.v1` ledger with source 'human'
 *
 * Contract highlights (#1295):
 * - Only a person runs `label`; the orchestrator never writes the ledger.
 * - `outcomeId = swarm:<sessionId>`; first label wins, replays are no-ops.
 * - The pick is blind by default: no persona or model names before the answer.
 * - Single-user CLI: two concurrent labels are last-writer-wins; atomic writes
 *   prevent file corruption, and the outcomeId dedupe prevents double counting
 *   in the normal (sequential) case.
 */
import os from 'node:os';
import path from 'node:path';
import { SwarmOrchestrator } from '../swarm/SwarmOrchestrator.js';
import { DEFAULT_PERSONAS } from '../swarm/personas.js';
import { VotingEngine } from '../swarm/VotingEngine.js';
import { LLMClient } from '../llm/LLMClient.js';
import { loadProjectConfig } from '../config/ConfigLoader.js';
import {
  inferVoteSource,
  listSwarmSessions,
  loadSwarmSession,
  writeSessionLabel,
  type SwarmSessionCandidate,
  type SwarmSessionLabel,
  type SwarmSessionRecord,
} from '../swarm/SwarmSession.js';
import type { SwarmConfig, SwarmMode, SwarmOllamaCaller } from '../swarm/types.js';

export interface SwarmCliFlags {
  prompt?: string;
  swarmMode?: string;
  swarmRounds?: number;
  sessionDir?: string;
  ledger?: string;
  winner?: string;
  noLabel?: boolean;
  reveal?: boolean;
  all?: boolean;
  limit?: string;
  domain?: string;
}

type LineWriter = (line?: string) => void;

export interface SwarmCliDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  stdout?: LineWriter;
  stderr?: LineWriter;
  stdinIsTTY?: boolean;
  /** Test seam for the interactive answer; resolves '' on EOF. */
  ask?: (question: string) => Promise<string>;
  /** Test seam: stub the provider caller so no network/model call happens. */
  callOllama?: SwarmOllamaCaller;
  /** Pre-loaded project config (defaults to `config/sinter.json` in cwd). */
  projectConfig?: { swarm?: { calibrationLedgerPath?: string } } | null;
  /** Test seam: extra orchestrator config (personas, skipRouting, …). */
  swarmConfig?: Partial<SwarmConfig>;
  now?: () => Date;
}

const SWARM_MODES = ['competitive', 'hybrid', 'ring', 'mesh'] as const;

const BANNER =
  'Swarm output is exploratory; a label calibrates voter weights, it does not admit an artifact.';

export function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2));
  return raw;
}

export function defaultSessionDir(home: string = os.homedir()): string {
  return path.join(home, '.sinter', 'swarm', 'sessions');
}

export function defaultLedgerPath(home: string = os.homedir()): string {
  return path.join(home, '.sinter', 'calibration', 'voting-calibration.json');
}

/** `--session-dir` > `SINTER_SWARM_SESSION_DIR` > `~/.sinter/swarm/sessions`. */
export function resolveSessionDir(
  flags: SwarmCliFlags,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const raw = flags.sessionDir ?? env.SINTER_SWARM_SESSION_DIR;
  return raw && raw.trim() ? expandHome(raw, home) : defaultSessionDir(home);
}

/**
 * `--ledger` > `SINTER_CALIBRATION_LEDGER` > config `swarm.calibrationLedgerPath`
 * > `~/.sinter/calibration/voting-calibration.json`.
 */
export async function resolveLedgerPath(
  flags: SwarmCliFlags,
  deps: SwarmCliDeps = {},
): Promise<string> {
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  if (flags.ledger && flags.ledger.trim()) return expandHome(flags.ledger, home);
  const fromEnv = env.SINTER_CALIBRATION_LEDGER;
  if (fromEnv && fromEnv.trim()) return expandHome(fromEnv, home);
  const config = deps.projectConfig !== undefined
    ? deps.projectConfig
    : await readProjectSwarmConfig(deps.cwd ?? process.cwd());
  const configured = config?.swarm?.calibrationLedgerPath;
  if (configured && configured.trim()) return expandHome(configured, home);
  return defaultLedgerPath(home);
}

async function readProjectSwarmConfig(
  cwd: string,
): Promise<{ swarm?: { calibrationLedgerPath?: string } } | null> {
  const result = await loadProjectConfig(cwd);
  return result.match(
    (config) => config as { swarm?: { calibrationLedgerPath?: string } },
    () => null,
  );
}

/** Provider-backed caller: persona system prompts reach the configured provider. */
export function createProviderSwarmCaller(client?: LLMClient): SwarmOllamaCaller {
  const llm = client ?? new LLMClient({ role: 'generator' });
  return async (_model, systemPrompt, userPrompt, options) => {
    const response = await llm.generate(
      systemPrompt,
      userPrompt,
      options?.signal,
      false,
      undefined,
      options?.num_predict ? { maxTokens: options.num_predict } : undefined,
    );
    if (!response.success) throw new Error(response.error ?? 'LLM generation failed');
    return response.code;
  };
}

async function defaultAsk(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } catch {
    return '';
  } finally {
    rl.close();
  }
}

function formatWhen(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function recordedVoters(record: SwarmSessionRecord): string[] {
  const seen = new Set<string>();
  const voters: string[] = [];
  for (const round of record.rounds) {
    for (const [voterId, vote] of Object.entries(round.votes)) {
      if (!vote.firstChoice || seen.has(voterId)) continue;
      seen.add(voterId);
      voters.push(voterId);
    }
  }
  return voters;
}

function hasParsedVotes(record: SwarmSessionRecord): boolean {
  return record.rounds.some(round =>
    Object.values(round.votes).some(vote => Boolean(vote.firstChoice)));
}

/**
 * Votes kept in the record but never used as calibration evidence: heuristic
 * self-votes and fallback placeholders (see VotingEngine.calibrateFromResult).
 * Mirrors the engine's skip predicate, including the legacy backfill.
 */
function countSyntheticVotes(record: SwarmSessionRecord): number {
  let count = 0;
  for (const round of record.rounds) {
    for (const [voterId, vote] of Object.entries(round.votes)) {
      if (!vote.firstChoice) continue;
      if ((vote.voteSource ?? inferVoteSource(voterId, vote)) !== 'llm') count++;
    }
  }
  return count;
}

function printBlindCandidates(candidates: SwarmSessionCandidate[], out: LineWriter): void {
  out('Candidates (blind):');
  for (const candidate of candidates) {
    const where = candidate.previewPath
      ? `preview ${candidate.previewPath}`
      : `source ${candidate.sourcePath}`;
    out(`  ${candidate.index}  ${candidate.lines} line${candidate.lines === 1 ? '' : 's'}  ${where}`);
  }
}

function printReveal(candidates: SwarmSessionCandidate[], out: LineWriter): void {
  out('Reveal (debug):');
  for (const candidate of candidates) {
    out(`  ${candidate.index}  ${candidate.personaId} (${candidate.personaName}, ${candidate.model})`);
  }
}

function printRecordedLabel(
  record: SwarmSessionRecord,
  candidate: SwarmSessionCandidate,
  recorded: number,
  ledgerPath: string,
  out: LineWriter,
): void {
  out(`✓ Label recorded: #${candidate.index} (${candidate.personaId}, ${candidate.personaName})`);
  const voters = recordedVoters(record);
  const skipped = record.label?.skippedSyntheticVotes ?? 0;
  const synthetic = skipped > 0 ? ` (${skipped} synthetic vote${skipped === 1 ? '' : 's'} excluded)` : '';
  out(`  ${recorded} votes from ${voters.length} voters across ${record.rounds.length} round${record.rounds.length === 1 ? '' : 's'}${synthetic} → ${ledgerPath}`);
  out(`  outcomeId swarm:${record.sessionId} (replays are ignored)`);
}

function printLabelLater(record: SwarmSessionRecord, out: LineWriter): void {
  out(`Label later with: sinter swarm label ${record.sessionId}`);
}

function printSessions(
  records: SwarmSessionRecord[],
  opts: { all: boolean; out: LineWriter; sessionDir?: string },
): void {
  if (records.length === 0) {
    opts.out(`No swarm sessions found${opts.sessionDir ? ` in ${opts.sessionDir}` : ''}${opts.all ? '' : ' (labelled sessions are hidden; use --all to include them)'}. Run: sinter swarm run --prompt "<prompt>"`);
    return;
  }
  opts.out(''
    + 'ID'.padEnd(25)
    + 'WHEN'.padEnd(18)
    + 'DOMAIN'.padEnd(12)
    + 'ROUNDS'.padEnd(8)
    + 'CANDIDATES'.padEnd(12)
    + 'LABEL');
  for (const record of records) {
    opts.out(''
      + record.sessionId.padEnd(25)
      + formatWhen(record.createdAt).padEnd(18)
      + String(record.domain).padEnd(12)
      + String(record.rounds.length).padEnd(8)
      + String(record.candidates.length).padEnd(12)
      + (record.label?.goldWinner ?? '—'));
  }
  if (!opts.all) opts.out('(labelled sessions hidden; use --all to include them)');
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return 20;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

function resolveWinner(
  record: SwarmSessionRecord,
  raw: string,
): SwarmSessionCandidate | null {
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const index = Number(value);
    return record.candidates.find(candidate => candidate.index === index) ?? null;
  }
  return record.candidates.find(candidate => candidate.personaId === value) ?? null;
}

function describeValidWinners(record: SwarmSessionRecord): string {
  const ids = record.candidates.map(candidate => candidate.personaId).join(', ');
  return `1-${record.candidates.length} (${ids})`;
}

type LabelOutcome =
  | { kind: 'recorded'; record: SwarmSessionRecord; candidate: SwarmSessionCandidate; recorded: number }
  | { kind: 'replay'; label: SwarmSessionLabel }
  | { kind: 'replay-ledger' };

async function applyLabel(
  record: SwarmSessionRecord,
  candidate: SwarmSessionCandidate,
  sessionDir: string,
  ledgerPath: string,
): Promise<LabelOutcome> {
  if (record.label) return { kind: 'replay', label: record.label };
  const outcomeId = `swarm:${record.sessionId}`;
  VotingEngine.attachLedger(ledgerPath);
  if (VotingEngine.hasOutcome(outcomeId)) return { kind: 'replay-ledger' };

  const rounds = record.rounds.map(round => ({
    votes: new Map(Object.entries(round.votes).map(([voterId, vote]) => [voterId, {
      voterId,
      firstChoice: vote.firstChoice,
      secondChoice: vote.secondChoice,
      reasoning: vote.reasoning,
      voteSource: vote.voteSource ?? inferVoteSource(voterId, vote),
    }])),
  }));
  const recorded = VotingEngine.calibrateFromResult(
    { rounds },
    candidate.personaId,
    record.prompt,
    { source: 'human', outcomeId },
  );
  if (recorded === 0) return { kind: 'replay-ledger' };

  const skippedSyntheticVotes = countSyntheticVotes(record);
  const label: SwarmSessionLabel = {
    source: 'human',
    goldWinner: candidate.personaId,
    outcomeId,
    labelledAt: new Date().toISOString(),
    recordedVotes: recorded,
    recordedVoters: recordedVoters(record),
    ...(skippedSyntheticVotes > 0 ? { skippedSyntheticVotes } : {}),
  };
  const next = await writeSessionLabel(sessionDir, record, label);
  return { kind: 'recorded', record: next, candidate, recorded };
}

function printLabelOutcome(
  outcome: LabelOutcome,
  record: SwarmSessionRecord,
  ledgerPath: string,
  out: LineWriter,
): void {
  if (outcome.kind === 'recorded') {
    printRecordedLabel(outcome.record, outcome.candidate, outcome.recorded, ledgerPath, out);
    return;
  }
  if (outcome.kind === 'replay') {
    out(`Already labelled: ${outcome.label.goldWinner} on ${outcome.label.labelledAt.slice(0, 10)} — 0 new votes; ledger unchanged.`);
    return;
  }
  out(`Already labelled in the ledger for swarm:${record.sessionId} — 0 new votes; ledger unchanged.`);
}

function printCalibration(record: SwarmSessionRecord, calibratedVoterIds: string[], out: LineWriter): void {
  const voters = calibratedVoterIds.length > 0 ? calibratedVoterIds.join(', ') : 'none yet';
  const domain = record.domain || VotingEngine.inferDomain(record.prompt);
  out(`Calibrated voters (${domain}): ${voters}`);
}

/** Guard shared by `run` (after the run) and `label`: refuse an unusable record. */
function assertLabelable(record: SwarmSessionRecord): string | null {
  if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
    return `Session ${record.sessionId} has no prompt (legacy record); re-run it with this version of \`sinter swarm run\`.`;
  }
  if (!hasParsedVotes(record)) {
    return `Session ${record.sessionId} has no parsed votes; nothing to calibrate against.`;
  }
  if (record.candidates.length === 0) {
    return `Session ${record.sessionId} has no viable final candidates; nothing to label.`;
  }
  return null;
}

async function runCommand(
  argv: string[],
  flags: SwarmCliFlags,
  deps: SwarmCliDeps,
): Promise<number> {
  const out = deps.stdout ?? ((line = '') => console.log(line));
  const err = deps.stderr ?? ((line = '') => console.error(line));
  const home = deps.home ?? os.homedir();
  const positionalPrompt = argv.join(' ').trim();
  const prompt = (flags.prompt ?? positionalPrompt).trim();
  if (!prompt) {
    err('Error: --prompt is required for `sinter swarm run`.');
    err('Usage: sinter swarm run --prompt "<prompt>" [--swarm-mode <mode>] [--swarm-rounds N] [--no-label] [--session-dir <path>] [--ledger <path>]');
    return 1;
  }
  if (flags.domain) {
    err('Error: --domain is not supported by `sinter swarm`; the domain is inferred from the prompt.');
    return 1;
  }
  const requestedMode = flags.swarmMode ?? 'hybrid';
  if (!(SWARM_MODES as readonly string[]).includes(requestedMode)) {
    err(`Error: unknown swarm mode "${flags.swarmMode}". Valid: ${SWARM_MODES.join(', ')}.`);
    return 1;
  }
  const mode = requestedMode as SwarmMode;
  if (flags.swarmRounds !== undefined
    && (!Number.isInteger(flags.swarmRounds) || flags.swarmRounds < 1)) {
    err('Error: --swarm-rounds must be a positive integer.');
    return 1;
  }

  const sessionDir = resolveSessionDir(flags, deps.env ?? process.env, home);
  const ledgerPath = await resolveLedgerPath(flags, { ...deps, home });

  out(BANNER);
  out('');
  out(`Running swarm (${mode}, up to ${flags.swarmRounds ?? 10} round${(flags.swarmRounds ?? 10) === 1 ? '' : 's'})…`);
  // Disclose the panel before spending (spec §14) without leaking which
  // candidate belongs to which persona.
  const panelPersonas = deps.swarmConfig?.personas ?? DEFAULT_PERSONAS;
  const panelModels = [...new Set(panelPersonas.map(persona => persona.model))];
  const maxRounds = flags.swarmRounds ?? deps.swarmConfig?.maxRounds ?? 10;
  out(`Panel: ${panelPersonas.length} personas · ${panelModels.join(', ')}`);

  const orchestrator = new SwarmOrchestrator({
    ...deps.swarmConfig,
    sessionDir,
    streamDir: path.join(sessionDir, 'stream'),
    ...(flags.swarmRounds !== undefined ? { maxRounds: flags.swarmRounds } : {}),
  }, {
    callOllama: deps.callOllama ?? createProviderSwarmCaller(),
    calibrationLedgerPath: ledgerPath,
  });

  // The default caller reaches the provider: open the same receipted product grant as generate.
  // An injected caller (tests, offline callers) never reaches a provider and needs none.
  const result = deps.callOllama
    ? await orchestrator.run(prompt, mode)
    : await (async () => {
      const { runProductionCliProviderEffect } = await import('./LiminalProductionProviderEffect.js');
      const { randomUUID } = await import('node:crypto');
      return runProductionCliProviderEffect({
        idempotencyKey: `production-swarm-run:${randomUUID()}`,
        binding: { surface: 'swarm-run', mode, maxRounds, panelSize: panelPersonas.length },
        // One generation per persona per round, plus final-round voting.
        maxGeneratorAttempts: panelPersonas.length * (maxRounds + 1),
        effect: () => orchestrator.run(prompt, mode),
      });
    })();
  for (const round of result.rounds) {
    out(`Round ${round.roundNum}: ${round.outputs.size} outputs`);
  }
  if (result.converged && result.convergenceRound !== null) {
    out(`Converged at round ${result.convergenceRound}.`);
  } else {
    out(`Stopped after ${result.rounds.length} round${result.rounds.length === 1 ? '' : 's'}.`);
  }
  out('');

  const sessionId = result.sessionId;
  if (!sessionId) {
    err('Error: the swarm run did not write a session record; nothing can be labelled.');
    return 1;
  }
  const record = await loadSwarmSession(sessionDir, sessionId);

  const guard = assertLabelable(record);
  if (guard) {
    err(`Error: ${guard}`);
    return 1;
  }

  printBlindCandidates(record.candidates, out);
  if (flags.reveal) printReveal(record.candidates, out);
  out('');

  const interactive = (deps.stdinIsTTY ?? Boolean(process.stdin.isTTY)) && !flags.noLabel;
  let outcome: LabelOutcome | null = null;
  if (!interactive) {
    printLabelLater(record, out);
  } else {
    const ask = deps.ask ?? defaultAsk;
    const answer = await ask(`Which output should have won? [1-${record.candidates.length}, s=skip] `);
    if (!answer || /^s$/i.test(answer)) {
      printLabelLater(record, out);
    } else {
      const candidate = resolveWinner(record, answer);
      if (!candidate) {
        out(`Unrecognised answer "${answer}"; no label recorded.`);
        printLabelLater(record, out);
      } else {
        outcome = await applyLabel(record, candidate, sessionDir, ledgerPath);
        printLabelOutcome(outcome, record, ledgerPath, out);
      }
    }
  }

  const finalRound = result.rounds[result.rounds.length - 1];
  printCalibration(record, finalRound?.votingDecision?.calibratedVoterIds ?? [], out);
  return 0;
}

async function sessionsCommand(flags: SwarmCliFlags, deps: SwarmCliDeps): Promise<number> {
  const out = deps.stdout ?? ((line = '') => console.log(line));
  const err = deps.stderr ?? ((line = '') => console.error(line));
  const home = deps.home ?? os.homedir();
  const limit = parseLimit(flags.limit);
  if (limit === null) {
    err('Error: --limit must be a positive integer.');
    return 1;
  }
  const sessionDir = resolveSessionDir(flags, deps.env ?? process.env, home);
  const records = await listSwarmSessions(sessionDir);
  const visible = flags.all ? records : records.filter(record => !record.label);
  printSessions(visible.slice(0, limit), { all: Boolean(flags.all), out, sessionDir });
  return 0;
}

async function labelCommand(
  argv: string[],
  flags: SwarmCliFlags,
  deps: SwarmCliDeps,
): Promise<number> {
  const out = deps.stdout ?? ((line = '') => console.log(line));
  const err = deps.stderr ?? ((line = '') => console.error(line));
  const home = deps.home ?? os.homedir();
  const sessionDir = resolveSessionDir(flags, deps.env ?? process.env, home);
  const interactive = deps.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const ask = deps.ask ?? defaultAsk;

  let sessionId = argv[0]?.trim() ?? '';
  if (!sessionId) {
    const records = await listSwarmSessions(sessionDir);
    printSessions(records, { all: true, out });
    if (!interactive) {
      err(`Error: provide a session id: sinter swarm label <sessionId> --winner <index|personaId>`);
      return 1;
    }
    const answer = await ask('Session id to label: ');
    if (!answer) {
      out('No session selected; nothing written.');
      return 0;
    }
    sessionId = answer;
  }

  const record = await loadSwarmSession(sessionDir, sessionId);
  const guard = assertLabelable(record);
  if (guard) {
    err(`Error: ${guard}`);
    return 1;
  }

  out(`Session ${record.sessionId} · ${record.domain} · ${record.rounds.length} round${record.rounds.length === 1 ? '' : 's'}`);
  out(`Prompt: ${record.prompt}`);
  out('');
  printBlindCandidates(record.candidates, out);
  if (flags.reveal) printReveal(record.candidates, out);
  out('');

  const ledgerPath = await resolveLedgerPath(flags, { ...deps, home });

  let candidate: SwarmSessionCandidate | null = null;
  if (flags.winner !== undefined) {
    candidate = resolveWinner(record, flags.winner);
    if (!candidate) {
      err(`Error: unknown winner "${flags.winner}". Valid: ${describeValidWinners(record)}.`);
      return 1;
    }
  } else if (!interactive) {
    out(`Label with: sinter swarm label ${record.sessionId} --winner <index|personaId>`);
    return 0;
  } else {
    const answer = await ask(`Which output should have won? [1-${record.candidates.length}, s=skip] `);
    if (!answer || /^s$/i.test(answer)) {
      printLabelLater(record, out);
      return 0;
    }
    candidate = resolveWinner(record, answer);
    if (!candidate) {
      err(`Error: unknown winner "${answer}". Valid: ${describeValidWinners(record)}.`);
      return 1;
    }
  }

  const outcome = await applyLabel(record, candidate, sessionDir, ledgerPath);
  printLabelOutcome(outcome, record, ledgerPath, out);
  return 0;
}

export function printSwarmUsage(write: LineWriter = (line = '') => console.error(line)): void {
  write('Usage: sinter swarm <run|sessions|label> [options]');
  write('');
  write('  sinter swarm run --prompt "<prompt>" [--swarm-mode hybrid] [--swarm-rounds N]');
  write('                   [--no-label] [--session-dir <path>] [--ledger <path>]');
  write('  sinter swarm sessions [--session-dir <path>] [--all] [--limit 20]');
  write('  sinter swarm label [<sessionId>] [--winner <personaId|index>]');
  write('                   [--session-dir <path>] [--ledger <path>] [--reveal]');
  write('');
  write('Blind by default: `--reveal` shows persona/model names for debugging only.');
}

export async function runSwarmCli(
  argv: string[],
  flags: SwarmCliFlags = {},
  deps: SwarmCliDeps = {},
): Promise<number> {
  const err = deps.stderr ?? ((line = '') => console.error(line));
  const sub = argv[0];
  try {
    switch (sub) {
      case 'run':
        return await runCommand(argv.slice(1), flags, deps);
      case 'sessions':
        return await sessionsCommand(flags, deps);
      case 'label':
        return await labelCommand(argv.slice(1), flags, deps);
      default:
        printSwarmUsage(err);
        return 1;
    }
  } catch (error) {
    err(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
