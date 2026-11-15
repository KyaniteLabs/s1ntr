import { describe, it, expect } from 'vitest';
import { loadIntakeSpecs, loadTaskDefs, formatIntakeFailures } from '../../../src/ledger/cli.js';

const spec = (id: string) => ({ id, taskClass: 'unit' }) as never;

describe('loadIntakeSpecs', () => {
  it('counts loaded, skipped (already exist) and failed tasks, keeping each failure reason', () => {
    const existing = new Set(['T2']);
    const created: string[] = [];
    const result = loadIntakeSpecs([spec('T1'), spec('T2'), spec('T3'), spec('T4')], {
      loadTask: (id: string) => (existing.has(id) ? ({ id } as never) : null),
      createTask: (s: { id: string }) => {
        if (s.id === 'T3') throw new Error('EACCES: permission denied');
        if (s.id === 'T4') throw 'plain string failure';
        created.push(s.id);
      },
    });
    expect(result.loaded).toBe(1);
    expect(created).toEqual(['T1']);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([
      { id: 'T3', reason: 'EACCES: permission denied' },
      { id: 'T4', reason: 'plain string failure' },
    ]);
  });

  it('reports no failures when every task is created', () => {
    const result = loadIntakeSpecs([spec('A')], { loadTask: () => null, createTask: () => {} });
    expect(result).toEqual({ loaded: 1, skipped: 0, failed: [] });
  });

  it('handles an empty spec list', () => {
    expect(loadIntakeSpecs([], { loadTask: () => null, createTask: () => {} }))
      .toEqual({ loaded: 0, skipped: 0, failed: [] });
  });
});

describe('formatIntakeFailures', () => {
  it('prints the count and only the first 3 reasons, noting the rest', () => {
    const failed = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, reason: `boom ${id}` }));
    expect(formatIntakeFailures(failed)).toEqual([
      '  Failed:       5',
      '    a: boom a',
      '    b: boom b',
      '    c: boom c',
      '    ...and 2 more',
    ]);
  });

  it('prints nothing when there are no failures', () => {
    expect(formatIntakeFailures([])).toEqual([]);
  });
});

describe('loadTaskDefs', () => {
  it('counts created tasks and keeps the reason for each failed one, in order', () => {
    const created: unknown[] = [];
    const result = loadTaskDefs([{ id: 'A' }, { id: 'B' }, { noId: true }, 'junk'], {
      createTask: (d: unknown) => {
        if ((d as { id?: string })?.id === 'B') throw new Error('duplicate id');
        if (typeof d === 'string') throw new Error('not an object');
        if ((d as { noId?: boolean }).noId) throw 'missing id';
        created.push(d);
      },
    });
    expect(result.loaded).toBe(1);
    expect(created).toEqual([{ id: 'A' }]);
    expect(result.failed).toEqual([
      { id: 'B', reason: 'duplicate id' },
      { id: '(no id)', reason: 'missing id' },
      { id: '(no id)', reason: 'not an object' },
    ]);
  });

  it('handles an empty definition list', () => {
    expect(loadTaskDefs([], { createTask: () => {} })).toEqual({ loaded: 0, failed: [] });
  });
});
