import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync('scripts/proof/live-creative-domain-execution.ts', 'utf8');
const launchDomains = ['p5', 'svg', 'glsl', 'three', 'hydra', 'strudel', 'tone', 'revideo', 'hyperframes', 'ascii', 'kinetic', 'textgen', 'html', 'dataviz'];

describe('live creative-domain execution matrix', () => {
  it('defaults the live proof to every launch-scoped creative domain', () => {
    expect(script).toContain('LAUNCH_CREATIVE_DOMAINS');
    for (const domain of launchDomains) {
      expect(script).toMatch(new RegExp(`['"]${domain}['"]`));
    }
    expect(script).toMatch(/let domains: Domain\[\] = \[\.\.\.LAUNCH_CREATIVE_DOMAINS\]/);
    expect(script).toContain('readCurrentGitCommit');
    expect(script).toContain('computeProofSourceFingerprint');
    expect(script).toMatch(/gitCommit:\s*readCurrentGitCommit\(process\.cwd\(\)\)/);
    expect(script).toMatch(/sourceFingerprint:\s*computeProofSourceFingerprint\(process\.cwd\(\)\)/);
    expect(script).toContain('validateCreativeDomainArtifact');
    expect(script).toContain('artifactValidation');
  });

  it('treats HyperFrames as the HTML-backed video output and includes HTML + DataViz in the 14-domain launch set', () => {
    expect(script).toContain('HyperFramesGenerator');
    expect(script).toMatch(/hyperframes:\s*'create a HyperFrames/i);
    expect(script).toMatch(/hyperframes:\s*'html'/);
    expect(script).toContain("domain === 'hyperframes'");
    expect(script).toContain('useGeneratorTools: false');
    // The launch surface now includes generic HTML and the D3 dataviz domain
    // (widened from 12 to 14). They generate via their real generators and save
    // as .html, sharing the html render path.
    expect(script).toContain("case 'html': return new HTMLWebGenerator");
    expect(script).toContain("case 'dataviz': return new DataVizGenerator");
    expect(script).toMatch(/html:\s*'html'/);
    expect(script).toMatch(/dataviz:\s*'html'/);
    expect(script).toMatch(/dataviz:\s*'create a D3\.js v7 bar chart/i);
  });

  it('keeps slow live-provider domains bounded without using the global timeout as a false failure', () => {
    expect(script).toContain('DOMAIN_TIMEOUT_FLOORS_MS');
    expect(script).toMatch(/ascii:\s*180_000/);
    expect(script).toMatch(/tone:\s*180_000/);
    expect(script).toMatch(/hyperframes:\s*240_000/);
  });

  it('normalizes generated artifacts before writing tracked proof files', () => {
    expect(script).toContain('function normalizeArtifactCode');
    expect(script).toContain('.map(line => line.trimEnd())');
    expect(script).toContain('normalizeArtifactCode(String(await generator.generate');
  });
});
