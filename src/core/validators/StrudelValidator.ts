/**
 * StrudelValidator - Strudel pattern language validation logic
 *
 * Strudel is a pattern library for live coding music.
 * It uses pattern functions like s(), note(), stack(), slow(), fast()
 */

import { scanCode } from '../../core/recovery/SourceRecovery.js';
import { SCALE_INTERVALS, getScaleNotes } from '../../music/TheoryEngine.js';

export interface StrudelValidationResult {
  valid: boolean;
  errors: string[];
  /** S4: theory-informed assessments for judges (non-blocking). */
  theoryAssessment?: string[];
}

export class StrudelValidator {
  /**
   * Validate Strudel pattern code structure
   */
  static validate(code: string): StrudelValidationResult {
    const errors: string[] = [];
    const trimmed = code.trim();

    if (!trimmed) {
      errors.push('Code is empty');
      return { valid: false, errors };
    }

    // Basic structure validation
    errors.push(...this.validateStructure(trimmed));

    // Quality checks
    errors.push(...this.validateQuality(trimmed));

    // Semantic validation
    errors.push(...this.validateSemantics(trimmed));

    const theory = this.theoryAssessment(trimmed);
    return {
      valid: errors.length === 0,
      errors,
      theoryAssessment: theory.length > 0 ? theory : undefined
    };
  }

  /**
   * Validate Strudel structure - must contain pattern functions
   */
  private static validateStructure(code: string): string[] {
    const errors: string[] = [];

    // Must have at least one pattern function
    const hasPatternFunction = /\$:\s*s\(|\.stack\(|sound\(|note\(|\bs\(["']/.test(code);

    if (!hasPatternFunction) {
      errors.push('Strudel code must contain pattern functions: s(), note(), stack(), or sound()');
    }

    // Leading-prose gate: chat seats emit their design process before the code;
    // stripReasoningText removes only the FIRST paragraph, so a surviving
    // prose sentence at the top means the artifact is prose-contaminated and
    // must go to recovery, never ship. A code line is never 4+ words with no
    // call punctuation ending in sentence punctuation.
    const firstContentLine = code.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('//'));
    if (firstContentLine) {
      const words = firstContentLine.split(/\s+/);
      const proseShaped = words.length >= 4 && !firstContentLine.includes('(') && /[.!;:]$/.test(firstContentLine);
      if (proseShaped) {
        errors.push('Strudel code starts with a prose sentence — emit raw pattern code only (recovery will extract the code block)');
      }
    }

    return errors;
  }

  /**
   * Validate Strudel quality
   */
  private static validateQuality(code: string): string[] {
    const errors: string[] = [];

    // Check for non-ASCII characters — the strudel transpiler's parser rejects
    // typographic characters (em-dash, arrow, curly quotes) even in comments.
    // The old CJK-only check let them through: code validated, then died
    // silently at performance time. The spine normalizes before validating;
    // this gate catches every other path.
    // Intentional control-char matching: this gate EXISTS to detect non-ASCII,
    // the exact pattern no-control-regex forbids by default.
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(code)) {
      errors.push('Strudel code contains non-ASCII characters (em-dashes, curly quotes, arrows — the transpiler rejects them even in comments; use ASCII only)');
    }

    // Check for valid pattern syntax
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip empty lines and comments
      if (!line || line.startsWith('//')) continue;

      // Check for $: prefix on pattern lines (optional but recommended)
      if (/\bs\(|note\(|sound\(/.test(line) && !line.startsWith('$:')) {
        // This is a warning-level issue, not an error
        // Strudel can work without $: in some contexts
      }
    }

    return errors;
  }

  /**
   * Validate Strudel semantics
   */
  private static validateSemantics(code: string): string[] {
    const errors: string[] = [];

    // Valid Strudel pattern functions
    const validFunctions = new Set([
      's', 'sound', 'note', 'n',
      'stack', 'seq', 'cat', 'fast', 'slow', 'early', 'late',
      'rev', 'jux', 'off', 'every', 'when', 'fix',
      'gain', 'cut', 'cutoff', 'resonance', 'hcutoff', 'hresonance',
      'bandf', 'bandq', 'delay', 'delaytime', 'delayfeedback',
      'room', 'size', 'orbit', 'speed', 'range', 'struct',
      'sine', 'saw', 'square', 'tri', 'rand',
      'irand', 'choose', 'pick', 'collect', 'cycle',
      'bite', 'chop', 'striate', 'slice', 'loopAt',
      'chunk', 'chunkback', 'invert', 'palindrome',
      'degrade', 'degradeBy', 'sometimes', 'sometimesBy',
      'often', 'rarely', 'almostNever', 'almostAlways',
      'hush', 'bpm', 'cps', 'setcps'
    ]);

    // Check for potential typos in function calls
    const funcCalls = code.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
    for (const match of funcCalls) {
      const funcName = match[1];
      if (!validFunctions.has(funcName) && !this.isJavaScriptBuiltin(funcName)) {
        // Could be a custom function - warn but don't error
      }
    }

    // Check for unmatched parentheses — on comment/string-stripped code only.
    // Mini-notation lives inside strings (note("c3 [e3, g3]"), smiles in
    // comments "// :)" and quoted prose previously broke the raw count and
    // false-rejected performable patterns. The scanner is the shared
    // recovery-chain implementation so validation and recovery agree. An
    // unterminated literal (odd quote — e.g. an apostrophe in prose that
    // leaked into the code) makes every count unreliable and is itself a
    // defect: the pattern cannot evaluate as written.
    const scan = scanCode(code);
    if (!scan.terminated) {
      errors.push('Strudel code has an unterminated string literal or comment (unbalanced quote)');
    }
    const codeOnly = scan.text;
    const openParens = (codeOnly.match(/\(/g) || []).length;
    const closeParens = (codeOnly.match(/\)/g) || []).length;
    if (openParens !== closeParens) {
      errors.push(`Strudel code has unmatched parentheses: ${openParens} opening, ${closeParens} closing`);
    }

    return errors;
  }

  /**
   * Check if a name is a JavaScript builtin
   */
  private static isJavaScriptBuiltin(name: string): boolean {
    const builtins = new Set([
      'Array', 'Object', 'String', 'Number', 'Math', 'console', 'log',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'parseInt', 'parseFloat', 'JSON', 'Date'
    ]);
    return builtins.has(name);
  }

  /**
   * Get minimum size requirement for Strudel code
   */
  static getMinSize(): number {
    // A complete playable pattern can be a single short expression. Structural
    // validation and captured sound determine validity; padding is not quality.
    return 1;
  }

  /** S4 (Great Rewiring): theory-informed assessment — non-blocking.
   * Detects scale/chord references and checks theory correctness. Adds
   * assessments (for judges to see), never blocks generation. The theory
   * engine was dormant; this is its first live consumer. */
  private static theoryAssessment(code: string): string[] {
    const assessments: string[] = [];
    const lower = code.toLowerCase();
    // Detect scale references
    const scaleMatch = lower.match(/scale\s*\(?\s*['"]([a-g])\s*(major|minor|dorian|lydian|mixolydian|phrygian)/);
    if (scaleMatch) {
      const root = scaleMatch[1].toUpperCase();
      const type = scaleMatch[2];
      if (SCALE_INTERVALS[type]) {
        const notes = getScaleNotes(root, type, 4, 5);
        assessments.push(`Theory: ${root} ${type} scale detected — ${notes.length} notes, valid construction.`);
      }
    }
    // Detect chord progression references
    const chordMatches = code.match(/\b([Ii]{1,3}|[Vv]{1,3}|[iv]{1,3})\b/g);
    if (chordMatches && chordMatches.length >= 3) {
      assessments.push(`Theory: Roman-numeral chord progression detected (${chordMatches.length} references) — theory-aware judging recommended.`);
    }
    // Detect named chords (Cmaj7, Am, etc.)
    const namedChords = code.match(/\b([A-G][#b]?(?:maj|min|m|dim|aug|sus[24]?|7|9|11|13|m7|M7|dim7|aug7)?)\b/g);
    if (namedChords && namedChords.length >= 2) {
      assessments.push(`Theory: ${namedChords.length} named chords detected (${namedChords.slice(0, 4).join(', ')}${namedChords.length > 4 ? '…' : ''}) — check harmonic coherence.`);
    }
    return assessments;
  }

}
