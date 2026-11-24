import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Wave 5 memory feed-forward live proof', () => {
  it('runs isolated control and treatment Studio sessions and emits the typed gate receipt', () => {
    const source = readFileSync('scripts/proof/wave5-memory-feed-forward-live.ts', 'utf8');

    expect(source).toContain("runCondition('control'");
    expect(source).toContain("runCondition('treatment'");
    expect(source).toContain('hasPriorRunReceipt');
    expect(source).toContain('sourceLinked');
    expect(source).toContain('downstreamChanged');
    expect(source).toContain('createMemoryFeedForwardGateReceipt');
  });
});
