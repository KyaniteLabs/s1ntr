import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LSPTool } from '../../../src/harness/tools/LSPTool.js';

const SOURCE = [
  'export const alphaValue = 1;',
  'export async function alphaLoader() {}',
  'const betaThing = alphaValue + 2;',
  'alpha',
  '',
].join('\n');

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lsp-tool-'));
  file = join(dir, 'sample.ts');
  writeFileSync(file, SOURCE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('LSPTool autocomplete', () => {
  it('completes identifiers in the file that extend the typed prefix, excluding the prefix itself', async () => {
    const res = await new LSPTool().execute({ operation: 'autocomplete', path: file, line: 3, character: 5 });
    expect(res).toEqual({
      success: true,
      data: { completions: [{ label: 'alphaValue', kind: 'identifier' }, { label: 'alphaLoader', kind: 'identifier' }] },
    });
  });

  it('returns no completions when nothing precedes the cursor', async () => {
    const res = await new LSPTool().execute({ operation: 'autocomplete', path: file, line: 4, character: 0 });
    expect(res).toEqual({ success: true, data: { completions: [] } });
  });

  it('rejects an out-of-range line', async () => {
    const res = await new LSPTool().execute({ operation: 'autocomplete', path: file, line: 99, character: 0 });
    expect(res).toEqual({ success: false, error: 'Line 99 out of range' });
  });

  it('reports a missing file as an error', async () => {
    const res = await new LSPTool().execute({ operation: 'autocomplete', path: join(dir, 'nope.ts'), line: 0, character: 1 });
    expect(res.success).toBe(false);
    expect(res.error).toContain('ENOENT');
  });
});

describe('LSPTool definition', () => {
  it('finds the definition line of the identifier before the cursor', async () => {
    // line 2 is `const betaThing = alphaValue + 2;`; cursor after "alphaValue"
    const res = await new LSPTool().execute({ operation: 'definition', path: file, line: 2, character: 28 });
    expect(res).toEqual({
      success: true,
      data: { definitions: [{ file, line: 1, text: 'export const alphaValue = 1;' }] },
    });
  });

  it('reports no identifier when the cursor follows punctuation', async () => {
    const res = await new LSPTool().execute({ operation: 'definition', path: file, line: 1, character: 35 });
    expect(res.success).toBe(false); // cursor after "(": identifier is empty
    expect(res.error).toBe('No identifier at cursor');
  });

  it('reports when no definition exists', async () => {
    writeFileSync(file, 'const x = missingName\n');
    const res = await new LSPTool().execute({ operation: 'definition', path: file, line: 0, character: 21 });
    expect(res).toEqual({ success: false, error: "No definition found for 'missingName'" });
  });

  it('rejects an out-of-range line', async () => {
    const res = await new LSPTool().execute({ operation: 'definition', path: file, line: -1, character: 0 });
    expect(res).toEqual({ success: false, error: 'Line -1 out of range' });
  });
});
