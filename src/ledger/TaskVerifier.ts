/**
 * TaskVerifier — Combines ScoringEngine + execSync for task verification.
 *
 * Scores the generated code semantically via ScoringEngine and runs
 * the task's verify command (e.g. pnpm test) to determine pass/fail.
 * Records the resulting candidate in the TaskLedger.
 */

import { ScoringEngine } from '../core/ScoringEngine.js';
import type { TaskManifest, TaskCandidate, TaskAttempt } from './types.js';
import type { TaskLedger } from './TaskLedger.js';
import { execFileSync } from 'node:child_process';

/**
 * Allowed command heads, matched token-for-token. A string prefix is not a
 * boundary: "npx vitest-evil" starts with "npx vitest" but makes npx fetch and
 * run a different package (#1328).
 */
const ALLOWED_COMMAND_HEADS: readonly (readonly string[])[] = [
  ['pnpm', 'test'],
  ['pnpm', 'build'],
  ['pnpm', 'vitest'],
  ['npx', 'vitest'],
];

/**
 * Trailing flags known to be inert. Everything else that starts with "-" is
 * rejected, because runners accept flags that load and execute code
 * (--config, --globalSetup, --setupFiles, --reporter=<path>, ...) or forward
 * arbitrary arguments ("--").
 */
const ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  '--no-coverage',
  '--coverage=false',
  '--run',
  '--passWithNoTests',
]);

/** Relative path or test-name filter: no leading dash, no absolute path, no "..". */
const SAFE_OPERAND_RE = /^[A-Za-z0-9_][A-Za-z0-9_./@-]*$/;

// Shell metacharacters that enable chaining, substitution, or redirection
const SHELL_METACHAR_RE = /[&|;$`<>\n\\]/;

function describeHeads(): string {
  return ALLOWED_COMMAND_HEADS.map(h => h.join(' ')).join(', ');
}

/**
 * Parse a verify command into argv, failing closed. execFileSync runs without
 * a shell, so the returned argv is exactly what executes.
 */
export function parseVerifyCommand(cmd: string): string[] {
  if (SHELL_METACHAR_RE.test(cmd)) {
    throw new Error(
      `Blocked: verifyCommand "${cmd}" contains shell metacharacters (${cmd.match(SHELL_METACHAR_RE)![0]})`,
    );
  }
  if (/["']/.test(cmd)) {
    throw new Error(`Blocked: verifyCommand "${cmd}" contains quotes; quoting is not supported`);
  }
  const argv = cmd.trim().split(/\s+/).filter(Boolean);
  const head = ALLOWED_COMMAND_HEADS.find(h => h.every((tok, i) => argv[i] === tok));
  if (!head) {
    throw new Error(
      `Blocked: verifyCommand "${cmd}" does not match allowed prefixes: ${describeHeads()}`,
    );
  }
  for (const arg of argv.slice(head.length)) {
    if (arg.startsWith('-')) {
      if (!ALLOWED_FLAGS.has(arg)) {
        throw new Error(`Blocked: verifyCommand "${cmd}" uses disallowed flag "${arg}"`);
      }
      continue;
    }
    if (!SAFE_OPERAND_RE.test(arg) || arg.split('/').includes('..')) {
      throw new Error(`Blocked: verifyCommand "${cmd}" has unsafe argument "${arg}"`);
    }
  }
  return argv;
}

export class TaskVerifier {
  private scoringEngine: ScoringEngine;

  constructor(private ledger: TaskLedger) {
    this.scoringEngine = new ScoringEngine();
  }

  async verify(task: TaskManifest, attempt: TaskAttempt, code: string): Promise<TaskCandidate> {
    // Reject before spending a scoring call on a command that cannot run.
    const [cmd, ...cmdArgs] = parseVerifyCommand(task.verifyCommand);

    const scoringResult = await this.scoringEngine.score({
      output: code,
      prompt: attempt.prompt,
      criteria: task.scoringCriteria,
    });

    let testPassed = false;
    let verifyStdout = '';
    let verifyStderr = '';
    try {
      verifyStdout = execFileSync(cmd, cmdArgs, {
        timeout: 120000,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      testPassed = true;
    } catch (err: unknown) {
      testPassed = false;
      if (err && typeof err === 'object') {
        const execErr = err as { stdout?: string; stderr?: string };
        verifyStdout = execErr.stdout ?? '';
        verifyStderr = execErr.stderr ?? '';
      }
    }

    const candidate: TaskCandidate = {
      id: `cand-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: task.id,
      attemptId: attempt.id,
      code,
      semanticScore: scoringResult.score,
      testPassed,
      evaluatedAt: new Date().toISOString(),
      verifyStdout,
      verifyStderr,
    };

    this.ledger.recordCandidate(candidate);
    return candidate;
  }
}
