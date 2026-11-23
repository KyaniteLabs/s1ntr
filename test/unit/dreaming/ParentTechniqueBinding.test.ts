import { describe, expect, it } from 'vitest';
import { extractParentTechnique } from '../../../src/dreaming/research/ParentTechnique.js';
import { transferArmInstructions } from '../../../src/runtime-core/ProductionDreamHostAdapters.js';

const hex = (c: string) => c.repeat(64);

describe('F09 parent technique binding', () => {
  const shader = '<canvas></canvas><script>gl=c.getContext("webgl");gl_FragColor=1;requestAnimationFrame(f)</script>';
  const svg = '<svg><feTurbulence/><feDisplacementMap/></svg><style>div{mix-blend-mode:screen}</style>';

  it('different parent source gives a different technique digest and statement', () => {
    const a = extractParentTechnique(shader);
    const b = extractParentTechnique(svg);
    expect(a.cues).toContain('webgl-shader');
    expect(b.cues).toContain('svg-filters');
    expect(a.digest).not.toBe(b.digest);
    expect(a.statement).not.toBe(b.statement);
  });

  it('the treatment request carries the technique, the control request never does', () => {
    const treatA = transferArmInstructions(hex('f'), extractParentTechnique(shader).statement);
    const treatB = transferArmInstructions(hex('f'), extractParentTechnique(svg).statement);
    expect(treatA).not.toBe(treatB);
    expect(treatA).toContain('webgl-shader');
    expect(transferArmInstructions(null)).not.toContain('webgl-shader');
    expect(transferArmInstructions(hex('f'))).not.toContain('technique');
  });
});
