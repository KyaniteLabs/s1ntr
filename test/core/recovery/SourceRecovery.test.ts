import { describe, it, expect } from 'vitest';
import {
  stripFence,
  stripProsePreamble,
  stripRepairEnvelope,
  extractEmbeddedScript,
  stripStrudelInventedTail,
  stripCommentsAndStrings,
  isBalancedCode,
  extractFinalCodeBlock,
  transliterateTypography,
  extractFinalStanza,
  joinDanglingMethodChains,
  normalizeStrudelSource,
} from '../../../src/core/recovery/SourceRecovery.js';

describe('SourceRecovery (shared spine/rescue chain)', () => {
  it('unwraps the repair contract without stripping corrected artwork whitespace', () => {
    const art = '\n  ·\n    · ·\n       ·\n ';
    expect(stripRepairEnvelope('ROOT CAUSE: Output was too short.\nCORRECTED CODE:\n' + art))
      .toBe(art);
    expect(stripRepairEnvelope('<think>Check {the bounds}.</think>\r\nROOT CAUSE: Bad bounds.\r\nCORRECTED CODE:\r\n' + art))
      .toBe(art);
  });

  it('preserves labels and library declarations inside corrected code', () => {
    const code = 'const label = "CORRECTED CODE:";\nconst libraries = ["p5"];\n// ROOT CAUSE: a visible caption';
    expect(stripRepairEnvelope('ROOT CAUSE: Missing setup.\nCORRECTED CODE: ' + code))
      .toBe(code);
    expect(stripRepairEnvelope(code)).toBe(code);
    expect(stripRepairEnvelope('// ROOT CAUSE: caption\nCORRECTED CODE: text'))
      .toBe('// ROOT CAUSE: caption\nCORRECTED CODE: text');
  });

  it('leaves incomplete or unrelated repair labels intact', () => {
    for (const value of ['ROOT CAUSE: no corrected body', 'CORRECTED CODE:\nconst x = 1;',
      '<think>literal text</think>\nconst x = 1;']) {
      expect(stripRepairEnvelope(value)).toBe(value);
    }
  });

  it('recovers a fenced body after multiline explanations without changing its contents', () => {
    const code = 'const libraries = ["p5"];\n// CORRECTED CODE: caption';
    const reply = 'ROOT CAUSE: Missing setup {and bounds}.\nCHECK 2: Use valid imports.\nCORRECTED CODE:  \n```js\n' + code + '\n```';
    expect(stripFence(stripRepairEnvelope(reply))).toBe(code);
  });

  it('stripFence removes one wrapping markdown fence', () => {
    expect(stripFence('```js\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(stripFence('const a = 1;')).toBe('const a = 1;');
  });

  it('preserves text whitespace inside complete fences with surrounding newlines', () => {
    const text = '\n  art\n    ·\n ';
    expect(stripFence('```text\n' + text + '\n```', true)).toBe(text);
    expect(stripFence('\n```text\n' + text + '\n```\n', true)).toBe(text);
    expect(stripFence(text, true)).toBe(text);
    expect(stripFence('```text\n' + text, true)).toBe(text);
  });

  it('stripProsePreamble slices prose before the first code marker', () => {
    expect(stripProsePreamble('The user wants art. Here it is:\nconst a = 1;', 'p5')).toBe('const a = 1;');
    // prose containing code punctuation does not qualify (conservative refuse)
    expect(stripProsePreamble('Design; with semicolons\nconst a = 1;', 'p5')).toBeNull();
  });

  it('extractEmbeddedScript takes the largest inline script body', () => {
    const html = '<!DOCTYPE html><script>small();</script><script>const bigger = "x".repeat(50);</script>';
    expect(extractEmbeddedScript(html)).toContain('bigger');
    expect(extractEmbeddedScript('no scripts here')).toBeNull();
  });

  it('stripStrudelInventedTail removes trailing .tempo()/.start() in order', () => {
    expect(stripStrudelInventedTail('stack(s("bd")).tempo(90).start();')).toBe('stack(s("bd"))');
    expect(stripStrudelInventedTail('stack(s("bd")).start();')).toBe('stack(s("bd"))');
    expect(stripStrudelInventedTail('$: s("bd sd")')).toBe('$: s("bd sd")');
  });

  it('stripCommentsAndStrings removes comment and string contents', () => {
    const code = `// smiley :)
s("bd [sd, hh]") /* (block */ const x = "not (code";`;
    const stripped = stripCommentsAndStrings(code);
    expect(stripped).not.toContain('smiley');
    expect(stripped).not.toContain('bd [sd');
    expect(stripped).toContain('const x =');
  });

  it('isBalancedCode ignores brackets inside strings and comments', () => {
    expect(isBalancedCode('s("bd (sd") // :)')).toBe(true);
    expect(isBalancedCode('stack(s("bd"')).toBe(false);
  });

  it('isBalancedCode rejects unterminated literals (stray apostrophe prose)', () => {
    // prose with one ASCII apostrophe swallows the rest — balance is meaningless
    expect(isBalancedCode("Sample names must exist; Strudel's set.\nstack(s(\"bd\"))")).toBe(false);
    expect(isBalancedCode('stack(s("bd"))')).toBe(true);
  });

  it('extractFinalCodeBlock pulls the trailing code block out of design prose', () => {
    const raw = [
      'The user wants a Strudel piece: slow arpeggios over a drone.',
      '',
      'I should use s() for samples. Sample names must exist; click and cp are standard.',
      "Strudel's default set is enough.",
      '',
      'Here is the piece:',
      '',
      'setcpm(7)',
      'stack(',
      '  s("bd(5,16)").gain(.2).room(.4),',
      '  note("<[eb4,g4] [d4,f4]>").s("sine").slow(2)',
      ')',
    ].join('\n');
    const block = extractFinalCodeBlock(raw);
    expect(typeof block).toBe('string');
    expect(block).toMatch(/^setcpm\(7\)/);
    expect(block).not.toContain('The user wants');
    expect(isBalancedCode(block as string)).toBe(true);
  });

  it('extractFinalCodeBlock returns null when no balanced code suffix exists', () => {
    expect(extractFinalCodeBlock('Just prose about art. No code follows.')).toBeNull();
    expect(extractFinalCodeBlock('stack(s("bd"')).toBeNull();
  });

  describe('strudel intake guardrail (ghost-score study 2026-08-29)', () => {
    it('transliterateTypography converts the chars the transpiler rejects', () => {
      expect(transliterateTypography('// wet ink scroll \u2014 variation')).toBe('// wet ink scroll - variation');
      expect(transliterateTypography('a \u2192 b \u201Chi\u201D it\u2019s\u2026')).toBe('a -> b "hi" it\'s...');
      expect(transliterateTypography('plain ascii')).toBe('plain ascii');
    });

    it('extractFinalStanza isolates the closing composition from interleaved prose', () => {
      const doc = [
        'Notes:',
        '- Foundation: s("sawtooth") with low lpf.',
        'Actually wait \u2014 register consistency matters. Keep it.',
        '',
        'setcpm(7)',
        'stack(',
        '  // the stone \u2014 sub drone',
        '  s("sawtooth").note("<[eb1,eb2]>").lpf(110),',
        '  s("bd(5,16)").gain(.2).room(.4)',
        ')',
      ].join('\n');
      const stanza = extractFinalStanza(transliterateTypography(doc));
      expect(stanza).toMatch(/^setcpm\(7\)/);
      expect(stanza).not.toContain('Notes:');
      expect(stanza).not.toContain('Actually');
    });

    it('extractFinalStanza is a no-op on clean code', () => {
      const clean = 'setcpm(7)\nstack(\n  s("bd sd").gain(.2)\n)';
      expect(extractFinalStanza(clean)).toBe(clean);
    });

    it('joinDanglingMethodChains repairs truncated chains', () => {
      const truncated = 's("hh").attack(3).sustain(12).\n  release(4).gain(.05)';
      expect(joinDanglingMethodChains(truncated)).toBe('s("hh").attack(3).sustain(12).release(4).gain(.05)');
      const trailing = 's("bd").gain(.2).\n';
      expect(joinDanglingMethodChains(trailing)).not.toMatch(/\.\s*$/);
    });

    it('normalizeStrudelSource composes the full guardrail and is idempotent', () => {
      const ghost = [
        'The user wants a piece \u2014 variation 5932.',
        'Notes:',
        '- prose bullet about the design.',
        '',
        'setcpm(7)',
        'stack(',
        '  s("sine").note("<c3 e3 g3>").slow(2),',
        '  s("bd(3,8)").gain(.2).room(.4).',
        '  lpf(200)',
        ')',
      ].join('\n');
      const once = normalizeStrudelSource(ghost);
      expect(once).not.toContain('\u2014');
      expect(once).toMatch(/^setcpm\(7\)/);
      expect(once).toContain('.room(.4).lpf(200)');
      expect(normalizeStrudelSource(once)).toBe(once);
    });
  });
});
