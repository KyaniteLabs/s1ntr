// Every command that bin/sinter dispatches. Anything NOT here is treated as a
// natural-language creative prompt — so a missing command would be silently
// swallowed by the generate path instead of routing to its handler.
const KNOWN_COMMANDS = new Set([
  'help',
  'data',
  'archive',
  'gui-evolve',
  'sss-score',
  'rescue',
  'gbg',
  'field',
  'phases',
  'islands',
  'persona',
  'prompt-next',
  'conductor',
  'rotate',
  'hillclimb',
  'best-of',
  'second-judge',
  'third-judge',
  'budget',
  'name',
  'taxonomy',
  'authoritative-create',
  'authoritative-reevaluate',
  'campaign-continue',
  'campaign-owner-decision',
  'campaign-owner-decision-start',
  'judgment',
  'organism',
  'bridge',
  'chat',
  'compact',
  'compose',
  'composite',
  'compost',
  'rotation',
  'consolidate',
  'demo',
  'domains',
  'dream',
  'emergence',
  'fix',
  'fs',
  'g',
  'garden',
  'gen',
  'generate',
  'git',
  'image',
  'improve',
  'ledger',
  'list',
  'live-music',
  'ls',
  'market',
  'mece',
  'model',
  'preferences',
  'prompt',
  'provider',
  'quality',
  'readiness',
  'release',
  'report',
  's',
  'self-improve',
  'serve',
  'ship',
  'sing',
  'site',
  'studio',
  'swarm',
  'taste',
]);

/** Colon forms advertised in help (e.g. image:validate) must never become NL prompts. */
const KNOWN_COLON_COMMANDS = new Set(['image:validate', 'image:attach']);

/**
 * Normalize help-style `image:validate` into `image validate` argv shape.
 * Returns possibly rewritten [cmd, ...cmdArgs].
 */
export function normalizeCliCommand(
  cmd: string | null,
  cmdArgs: string[],
): { cmd: string | null; cmdArgs: string[] } {
  if (!cmd) return { cmd, cmdArgs };
  if (KNOWN_COLON_COMMANDS.has(cmd) || (cmd.startsWith('image:') && cmd.includes(':'))) {
    const [head, ...rest] = cmd.split(':');
    if (head && rest.length > 0) {
      return { cmd: head, cmdArgs: [...rest, ...cmdArgs] };
    }
  }
  return { cmd, cmdArgs };
}

export function isKnownCliCommand(cmd: string | null): boolean {
  if (!cmd) return false;
  if (KNOWN_COMMANDS.has(cmd) || KNOWN_COLON_COMMANDS.has(cmd)) return true;
  if (cmd.startsWith('image:') && KNOWN_COMMANDS.has('image')) return true;
  return false;
}

export function commandPrompt(flagPrompt: string | undefined, cmdArgs: string[]): string | null {
  if (flagPrompt !== undefined) return flagPrompt;
  const joined = cmdArgs.join(' ').trim();
  return joined.length > 0 ? joined : null;
}

export function inferNaturalLanguagePrompt(cmd: string | null, cmdArgs: string[]): string | null {
  if (!cmd || isKnownCliCommand(cmd)) return null;
  const joined = [cmd, ...cmdArgs].join(' ').trim();
  return joined.length > 0 ? joined : null;
}

/** What a command-shaped input near-miss looks like, for the front-door gate. */
export interface CommandTypoSuggestion {
  /** The known command the input most plausibly meant. */
  command: string;
  /** 'typo' = first token near-misses a command; 'quoted-phrase' = a single
   *  quoted argument whose first word IS a command (e.g. "taste status");
   *  'bare-word' = one lone word that is no command (e.g. `sinter status`),
   *  where `command` is 'help'. */
  reason: 'typo' | 'quoted-phrase' | 'bare-word';
}

const COMMAND_LIKE_MAX_WORDS = 4;
const BARE_WORD = /^[a-z][a-z0-9-]*$/i;

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

/**
 * Guard the natural-language front door against command-shaped accidents:
 * the NL path silently spends a PAID generation, so a short bare-word input
 * whose first token near-misses a known command (`sinter grden status`), or a
 * single quoted argument whose first word IS a command (`sinter "taste
 * status"`), is far more likely a mistyped command than a creative prompt
 * (audit F8 — both shapes were observed launching real generations).
 * Real creative prompts pass untouched: longer phrases, punctuation, or first
 * tokens nowhere near a command name. Callers must offer `--prompt` as the
 * explicit escape hatch when they reject the input.
 */
export function suggestCommandForTypo(cmd: string | null, cmdArgs: string[]): CommandTypoSuggestion | null {
  if (!cmd || isKnownCliCommand(cmd)) return null;

  // A single argument with internal whitespace (shell-quoted, or a shell that
  // didn't word-split) whose first word is a real command.
  if (cmdArgs.length === 0 && /\s/.test(cmd)) {
    const words = cmd.trim().split(/\s+/);
    if (words.length <= COMMAND_LIKE_MAX_WORDS && words.every(w => BARE_WORD.test(w)) && KNOWN_COMMANDS.has(words[0])) {
      return { command: words[0], reason: 'quoted-phrase' };
    }
    return null;
  }

  const words = [cmd, ...cmdArgs];
  if (words.length > COMMAND_LIKE_MAX_WORDS) return null;
  if (!words.every(w => BARE_WORD.test(w))) return null;

  const token = cmd.toLowerCase();
  let best: { command: string; distance: number } | null = null;
  for (const known of KNOWN_COMMANDS) {
    const distance = editDistance(token, known);
    if (!best || distance < best.distance) best = { command: known, distance };
  }
  const threshold = token.length <= 4 ? 1 : 2;
  if (best && best.distance <= threshold) return { command: best.command, reason: 'typo' };
  // Up to four unquoted bare words are how a command is typed (`sinter status`,
  // `sinter config show`), and these are nowhere near a real command name. A
  // prompt can always be given in quotes or with --prompt, so never spend on them.
  return { command: 'help', reason: 'bare-word' };
}

const SELF_IMPROVEMENT_MARKERS = [
  'improve yourself',
  'self-improve',
  'self improve',
  'improves itself',
  'improve itself',
  'self-improvement loop',
  'finish yourself',
  'finish building yourself',
  'improve your own',
  'improve the actual sinter application',
  'prompt -> sinter acts -> sinter improves itself',
  'codex for art',
];

export function isSelfImprovementPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return SELF_IMPROVEMENT_MARKERS.some(marker => normalized.includes(marker));
}
