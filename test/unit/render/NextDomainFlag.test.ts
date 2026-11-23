import { afterEach, describe, expect, it } from 'vitest';
import { entryNameForDomain } from '../../../src/core/GenerationOrchestrator.js';
import { renderNextDomain } from '../../../src/render/NextDomainRenderer.js';
import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';

afterEach(() => { delete process.env.SINTER_NEXT_DOMAINS; });

describe('next-domain flag (off by default)', () => {
  it('does not route datamosh to a generator unless the flag is on', () => {
    expect(entryNameForDomain('datamosh')).toBeNull();
    process.env.SINTER_NEXT_DOMAINS = '1';
    expect(entryNameForDomain('datamosh')).toBe('datamosh');
  });
  it('leaves every release domain routing unchanged with the flag on', () => {
    process.env.SINTER_NEXT_DOMAINS = '1';
    expect(entryNameForDomain('blender')).toBe('blender');
    expect(entryNameForDomain('glsl')).toBe('shader');
    expect(entryNameForDomain('p5')).toBe('p5');
  });
  it('renderNextDomain refuses with a message naming the flag when it is off', async () => {
    await expect(renderNextDomain('datamosh', '{}', {})).rejects.toThrow(/NEXT_DOMAIN_DISABLED:datamosh.*SINTER_NEXT_DOMAINS/);
  });
  it('HeadlessRenderer sends an enabled datamosh plan to the datamosh pipeline and reports a plan failure as a failed render', async () => {
    process.env.SINTER_NEXT_DOMAINS = 'datamosh';
    const r = await new HeadlessRenderer().render('{"segments":[{"clip":"nope","start":0,"duration":2}]}', { domain: 'datamosh' as never });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/datamosh plan failure/);
  });
});
