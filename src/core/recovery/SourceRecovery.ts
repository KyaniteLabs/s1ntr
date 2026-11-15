/**
 * SourceRecovery — the mechanical code-recovery chain shared by the generation
 * spine and the rescue organ. Extracted from LiminalProductionEffects so
 * `sinter rescue` recovers rejects with EXACTLY the same semantics the live
 * pipeline uses (duplicated recovery logic drifts; rejects must be judged by
 * the pipeline's own rules).
 */

/** Strip a single wrapping markdown code fence. */
export function stripFence(value: string, preserveWhitespace = false): string {
  if (preserveWhitespace) {
    const fenced = /^(?:[\t ]*\r?\n)*[\t ]*```[a-z0-9_-]*[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*```[\t ]*(?:\r?\n)?$/i.exec(value);
    return fenced ? fenced[1] : value;
  }
  return value.trim()
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/** Chat-tuned seats (glm-5.3 on the server) sometimes prepend a prose preamble
 *  ("The user wants…") before the code. Slice it off at the first real code
 *  marker — only ever used when full-source validation already failed, and the
 *  sliced source must validate clean to be accepted. */
export function stripProsePreamble(source: string, domain: string): string | null {
  const markers = domain === 'glsl' || domain === 'shader'
    ? [/precision\s+mediump|precision\s+highp|void\s+main\s*\(/]
    : [/function\s+setup\s*\(|function\s+draw\s*\(|createCanvas\s*\(|const\s+\w+\s*=|import\s+|THREE\.|osc\s*\(|Tone\.|new\s+AudioContext/];
  let index = -1;
  for (const marker of markers) {
    const match = marker.exec(source);
    if (match && (index === -1 || match.index < index)) index = match.index;
  }
  if (index <= 0) return null;
  const prefix = source.slice(0, index);
  // Only a prose prefix qualifies: sentences with spaces, no code punctuation.
  if (!/\s/.test(prefix) || /[;{}]/.test(prefix)) return null;
  return source.slice(index);
}

/** Unwrap only the explain-then-fix envelope requested by the repair prompt.
 * Keep the corrected body verbatim: labels inside code and artwork are data. */
export function stripRepairEnvelope(source: string): string {
  const envelope = /^(?:\s*<think>[\s\S]*?<\/think>\s*)?(?:[\t ]*\r?\n)*[\t ]*ROOT CAUSE:[\s\S]*?\r?\n[\t ]*CORRECTED CODE:[\t ]*(?:\r?\n)?/i.exec(source);
  return envelope ? source.slice(envelope[0].length) : source;
}

/** Seats sometimes emit a full HTML document for a raw-code domain (p5 sketch
 *  wrapped in <!DOCTYPE html>). Extract the largest inline <script> body — used
 *  only when full-source validation failed and the extract validates clean. */
export function extractEmbeddedScript(source: string): string | null {
  if (!/<script[\s>]/i.test(source)) return null;
  const bodies = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1].trim())
    .filter(b => b.length > 0)
    .sort((a, b) => b.length - a.length);
  return bodies[0] ?? null;
}

/** Generated strudel pieces often end with invented `.start()`/`.tempo()` calls
 *  that do not exist on Pattern (they throw at evaluate time). Strip ONLY a
 *  trailing occurrence — order matters: start-then-tempo (the wrapper plays
 *  the same strip, so rescue and playback agree). */
export function stripStrudelInventedTail(source: string): string {
  return source
    .replace(/\s*\.\s*start\s*\(\s*\)\s*;?\s*$/, '')
    .replace(/\s*\.\s*tempo\s*\([^)]*\)\s*;?\s*$/, '');
}

/** Remove comment bodies and string-literal contents so bracket counting only
 *  sees real code. Quote characters are kept as placeholders so string state
 *  cannot leak across lines (an apostrophe in prose would otherwise swallow
 *  half the code). Shared by StrudelValidator's paren gate and the recovery
 *  chain's balance check — one canonical implementation. */
export interface CodeScan {
  text: string;
  /** False when the scan ended inside a string/comment — the input has an
   *  unterminated literal (odd quote) or unclosed block comment, so any
   *  bracket count over it is unreliable and the code cannot run as-is. */
  terminated: boolean;
}

export function scanCode(code: string): CodeScan {
  let out = '';
  let state: 'code' | 'line-comment' | 'block-comment' | "'" | '"' | '`' = 'code';
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line-comment'; i++; continue; }
      if (char === '/' && next === '*') { state = 'block-comment'; i++; continue; }
      if (char === "'" || char === '"' || char === '`') { state = char; out += char; continue; }
      out += char;
    } else if (state === 'line-comment') {
      if (char === '\n') { state = 'code'; out += '\n'; }
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') { state = 'code'; i++; }
    } else {
      if (char === '\\') { i++; continue; }
      if (char === state) { state = 'code'; out += char; }
    }
  }
  return { text: out, terminated: state === 'code' || state === 'line-comment' };
}

export function stripCommentsAndStrings(code: string): string {
  return scanCode(code).text;
}

/** Parens/brackets/braces balanced on comment/string-stripped code. An
 *  unterminated literal also counts as unbalanced: after a stray apostrophe
 *  the count is meaningless (prose contamination reads as trivially
 *  balanced), so treat the whole text as not-code. */
export function isBalancedCode(code: string): boolean {
  const scan = scanCode(code);
  if (!scan.terminated) return false;
  const stripped = scan.text;
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const char of stripped) {
    if (char === '(' || char === '[' || char === '{') stack.push(char);
    else if (char in pairs) {
      if (stack.pop() !== pairs[char]) return false;
    }
  }
  return stack.length === 0;
}

function looksLikeCodeStart(line: string): boolean {
  return /^(?:[A-Za-z_$][\w$]*\s*[.(=]|\$:|\/\/|\/\*|[)}\];]|#|precision\b|uniform\b|void\b|const\b|let\b|var\b|function\b|import\b|new\b|export\b)/.test(line.trim());
}

/** Typographic → ASCII transliteration. The strudel transpiler's parser
 *  rejects em-dashes, arrows, curly quotes — even inside comments — while the
 *  loop's own prompt table writes em-dashes that the generator mirrors into
 *  its code. None of these characters carry meaning in pattern code. */
export function transliterateTypography(source: string): string {
  return source
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u00b7\u2022]/g, '-')
    .replace(/[\u2000-\u200f\u2028\u2029]/g, ' ');
}

function proseShapedLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith('//')) return false;
  const words = t.split(/\s+/);
  return words.length >= 4 && !t.includes('(') && !t.includes('=>') && /[.!?:;]$/.test(t);
}

/** The CONTIGUOUS FINAL code stanza: walk backwards from the last line,
 *  accepting code/comment/blank lines, stopping at the first prose-shaped
 *  line. On clean code this is the whole source (a no-op); on design-prose
 *  documents it isolates the finished closing composition from the interleaved
 *  reasoning. Prose INSIDE a block is what made "recovered" pieces silent —
 *  the transpiler dies at the first prose line. */
export function extractFinalStanza(source: string): string | null {
  const lines = source.split('\n');
  // Clean code (no prose anywhere) passes through untouched — the length
  // floor only guards junk suffixes inside prose documents.
  const hasProse = lines.some(line => proseShapedLine(line));
  if (!hasProse) {
    const whole = source.trim();
    return whole.length > 0 ? whole : null;
  }
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (end < 0) return null;
  let start = end;
  while (start >= 0) {
    const line = lines[start];
    if (!line.trim() || line.trim().startsWith('//')) { start--; continue; }
    if (proseShapedLine(line)) break;
    if (/[(){}[\]=;,$"'`]|=>|\.\w+|\$:/.test(line)) { start--; continue; }
    break;
  }
  start++;
  const stanza = lines.slice(start, end + 1).join('\n').trim();
  return stanza.length >= 80 ? stanza : null;
}

/** Join chains left dangling at end-of-line: glm truncates mid-chain leaving
 *  `..pan("<..>").` with the next line starting an identifier — a syntax
 *  error for the transpiler. Join `.` + next-line-identifier, or drop a
 *  trailing dot with nothing after it. */
export function joinDanglingMethodChains(source: string): string {
  return source
    .replace(/\.\s*\n(\s*)([A-Za-z_$][\w$]*\s*\()/g, '.$2')
    .replace(/\.\s*$/m, '');
}

/** Deterministic strudel intake normalization: typography, prose isolation,
 *  dangling chains, invented tails. Unconditional and idempotent — on clean
 *  code every step is a no-op. This is the guardrail, not recovery: the
 *  generator's formatting quirks are absorbed before validation ever runs. */
export function normalizeStrudelSource(source: string): string {
  let out = transliterateTypography(source);
  const hasProse = out.split('\n').some(line => proseShapedLine(line));
  if (hasProse) {
    const stanza = extractFinalStanza(out);
    if (stanza !== null) out = stanza;
  }
  out = joinDanglingMethodChains(out);
  return stripStrudelInventedTail(out);
}

/**
 * Chat seats (glm-5.3) emit their whole design process as prose with the real
 * artwork as the FINAL contiguous code block. The prose often contains `;`/`{}`
 * (so stripProsePreamble refuses) and its apostrophes/parens corrupt any
 * analysis over the mixed text. Mechanical extraction: the LARGEST suffix that
 * (a) starts at a code-shaped line and (b) is bracket-balanced on stripped
 * code — prose is never bracket-balanced together with the code that follows
 * it, so balance is the separator. Callers must still validate the extract.
 */
export function extractFinalCodeBlock(source: string): string | null {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i].trim();
    if (!first || !looksLikeCodeStart(first)) continue;
    const suffix = lines.slice(i).join('\n').trim();
    if (suffix.length < 80) continue;
    if (!isBalancedCode(suffix)) continue;
    return suffix;
  }
  return null;
}
