import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scriptPath = path.join(repoRoot, 'scripts', 'proof', 'creative-copilot-proof.ts');

describe('creative copilot proof script', () => {
  it('lists HTML for image proof and omits retired engines in a dry run', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'proof-domains-'));
    try {
      execFileSync(process.execPath, ['--import', 'tsx', scriptPath, '--dry', '--all', '--provider=ollama', `--out=${out}`]);
      const [run] = readdirSync(out);
      const { results } = JSON.parse(readFileSync(path.join(out, run, 'report.json'), 'utf8'));
      expect(results).toContainEqual(expect.objectContaining({ domain: 'html', previewKind: 'image', generationAttempts: 0 }));
      expect(results.map((row: { domain: string }) => row.domain)).not.toContain('revideo');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('persists reports, artifacts, screenshot previews, and issue evidence', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain("path.join('.omx', 'proof', 'creative-copilot')");
    expect(source).toContain('report.json');
    expect(source).toContain('report.md');
    expect(source).toContain('renderScreenshot');
    expect(source).toContain('shouldRenderScreenshot');
    expect(source).toContain('audio-playable');
    expect(source).toContain('audio-external');
    expect(source).toContain('KineticGenerator');
    expect(source).toContain('SVGGenerator');
    expect(source).toContain("domain: 'svg'");
    expect(source).toContain("artifactExtension: 'svg'");
    expect(source).toContain('validateScreenshotVisible');
    expect(source).toContain('Preview runtime error');
    expect(source).toContain("previewKind: 'image'");
    expect(source).toContain('createColorTheoryPalette');
    expect(source).toContain('promptWithColorTheory');
    expect(source).toContain('colorTheoryGuidance');
    expect(source).toContain('Launch color theory guidance');
    expect(source).toContain('max-tokens');
    expect(source).toContain('timeout-ms');
    expect(source).toContain('isEmptyGenerationFailure');
    expect(source).toContain('maxEmptyGenerationAttempts = 3');
    expect(source).toContain('empty response retry');
    expect(source).toContain('issues:');
    expect(source).toContain('getProviderConfig');
    expect(source).toContain('P5GeneratorV2');
  });
});
