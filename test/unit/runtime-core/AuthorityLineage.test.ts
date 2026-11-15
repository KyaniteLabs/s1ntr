import { describe, expect, it } from 'vitest';
import { AuthorityLineage } from '../../../src/runtime-core/AuthorityLineage.js';

const SHA = 'd'.repeat(64);

describe('AuthorityLineage', () => {
  it('links proposals and outcomes through a read-only query', () => {
    const lineage = new AuthorityLineage();
    lineage.add({ id: 'source-proposal', trustKind: 'source-change',
      relationIds: [], evidenceDigest: SHA });
    lineage.add({ id: 'creative-outcome', trustKind: 'creative',
      relationIds: ['source-proposal'], evidenceDigest: SHA });

    expect(lineage.query('creative-outcome').map(record => record.id))
      .toEqual(['creative-outcome', 'source-proposal']);
  });

  it('forbids trust casts across operational source capability and creative ladders', () => {
    const lineage = new AuthorityLineage();
    for (const trustKind of ['operational', 'source-change', 'capability', 'creative'] as const) {
      lineage.add({ id: trustKind, trustKind, relationIds: [], evidenceDigest: SHA });
    }
    expect(() => lineage.assertWriteAuthority('operational', 'creative'))
      .toThrow('AUTHORITY_TRUST_CAST_FORBIDDEN');
    expect(lineage.assertWriteAuthority('creative', 'creative').id).toBe('creative');
  });
});
