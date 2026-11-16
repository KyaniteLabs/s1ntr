import { describe, it, expect } from 'vitest';
import { HydraValidator } from '../../../src/core/validators/HydraValidator.js';
import { GenericWrapper, HYDRA_PIECE_PRELUDE } from '../../../src/core/wrappers/GenericWrapper.js';

const syntaxErrors = (code: string) =>
  HydraValidator.validate(code).errors.filter((e) => e.includes('syntax error'));

describe('Hydra validator parses the piece the way the shell runs it', () => {
  it('the shell embeds the exact prelude the validator parses behind', () => {
    const html = GenericWrapper.wrap('osc(10).out()', { domain: 'hydra' } as never);
    expect(html).toContain(HYDRA_PIECE_PRELUDE);
  });

  it('rejects a piece that redeclares o (shell already declares it)', () => {
    expect(syntaxErrors('const o = osc(10); o.out()')).not.toHaveLength(0);
  });

  it('rejects a piece that redeclares go', () => {
    expect(syntaxErrors('let go = 1; osc(10).out()')).not.toHaveLength(0);
  });

  it('rejects a top-level return', () => {
    expect(syntaxErrors('if (!window.ok) return;\nosc(10).out()')).not.toHaveLength(0);
  });

  it('accepts a piece that only uses o and go', () => {
    expect(syntaxErrors('osc(10).out(o); go()')).toHaveLength(0);
  });
});
