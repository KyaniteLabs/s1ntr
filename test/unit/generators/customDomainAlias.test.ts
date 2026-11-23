import { describe, expect, it } from 'vitest';
import { entryNameForDomain } from '../../../src/core/GenerationOrchestrator.js';
import { CodeValidator } from '../../../src/core/CodeValidator.js';
import { canonicalDomainId } from '../../../src/types/domains.js';

// The `meta` domain was renamed `custom`. `meta` stays a deprecated alias so
// running benches, the hillclimb and old corpora keep working.
describe('custom domain: --domain meta and --domain custom resolve to the same generator', () => {
  it.each(['custom', 'meta', 'META', ' Meta '])('--domain %j dispatches to the custom generator entry', (flag) => {
    expect(entryNameForDomain(flag)).toBe('custom');
  });

  it('the CLI boundary rewrites meta to custom and only meta', () => {
    expect(canonicalDomainId('meta')).toBe('custom');
    expect(canonicalDomainId('custom')).toBe('custom');
    expect(canonicalDomainId('dataviz')).toBe('dataviz');
  });

  it('a corpus row labelled meta validates exactly like one labelled custom', () => {
    const page = '<!--SINTER-META-DESCRIPTOR {"name":"x","runtime":"canvas","libraries":[],"renderTarget":"canvas","notes":"n"} -->\n'
      + '<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title></head><body><canvas id="c"></canvas><script>'
      + 'const c=document.getElementById("c").getContext("2d");c.fillRect(0,0,10,10);'.repeat(8)
      + '</script></body></html>';
    const viaCustom = CodeValidator.validate(page, 'custom');
    const viaMeta = CodeValidator.validate(page, 'meta');
    expect(viaMeta.valid).toBe(viaCustom.valid);
    expect(viaMeta.errors).toEqual(viaCustom.errors);
  });
});
