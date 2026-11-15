import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../../src/cortex/BudgetTracker.js';
describe('BudgetTracker', () => {
  it('starts with zero usage', () => { const bt = new BudgetTracker({ actionsLimit: 10, tokenLimit: 50000 }); const u = bt.getUsage(); expect(u.actionsTaken).toBe(0); expect(u.actionsLimit).toBe(10); });
  it('canAfford returns true when under limits', () => { expect(new BudgetTracker({ actionsLimit: 10, tokenLimit: 50000 }).canAfford({ tokenEstimate: 2000 })).toBe(true); });
  it('canAfford false when action limit reached', () => { const bt = new BudgetTracker({ actionsLimit: 2, tokenLimit: 50000 }); bt.record({ tokenEstimate: 1000 }); bt.record({ tokenEstimate: 1000 }); expect(bt.canAfford({ tokenEstimate: 1000 })).toBe(false); });
  it('canAfford false when token limit exceeded', () => { const bt = new BudgetTracker({ actionsLimit: 10, tokenLimit: 5000 }); bt.record({ tokenEstimate: 4000 }); expect(bt.canAfford({ tokenEstimate: 2000 })).toBe(false); });
  it('record increments actions and tokens', () => { const bt = new BudgetTracker({ actionsLimit: 10, tokenLimit: 50000 }); bt.record({ tokenEstimate: 1500 }); bt.record({ tokenEstimate: 2500 }); expect(bt.getUsage().actionsTaken).toBe(2); expect(bt.getUsage().tokenEstimate).toBe(4000); });
  it('reset clears usage', () => { const bt = new BudgetTracker({ actionsLimit: 10, tokenLimit: 50000 }); bt.record({ tokenEstimate: 3000 }); bt.reset(); expect(bt.getUsage().actionsTaken).toBe(0); expect(bt.getUsage().tokenEstimate).toBe(0); });
  it('reset preserves limits', () => { const bt = new BudgetTracker({ actionsLimit: 5, tokenLimit: 10000 }); bt.record({ tokenEstimate: 3000 }); bt.reset(); expect(bt.getUsage().actionsLimit).toBe(5); });
  it('canAfford at exact token boundary', () => { expect(new BudgetTracker({ actionsLimit: 10, tokenLimit: 5000 }).canAfford({ tokenEstimate: 5000 })).toBe(true); });
  it('zero-cost counts against limit', () => { const bt = new BudgetTracker({ actionsLimit: 1, tokenLimit: 50000 }); bt.record({ tokenEstimate: 0 }); expect(bt.canAfford({ tokenEstimate: 0 })).toBe(false); });
  it('rejects a negative estimate instead of refunding the budget (#1308)', () => {
    const bt = new BudgetTracker({ actionsLimit: 10, tokenLimit: 5000 });
    bt.record({ tokenEstimate: 4000 });
    expect(() => bt.record({ tokenEstimate: -4000 })).toThrow(/tokenEstimate must be a finite non-negative number/);
    expect(bt.getUsage()).toEqual({ actionsTaken: 1, actionsLimit: 10, tokenEstimate: 4000, tokenLimit: 5000 });
    expect(() => bt.canAfford({ tokenEstimate: Number.NaN })).toThrow(/tokenEstimate/);
  });
  it.each([
    [{ actionsLimit: -1, tokenLimit: 100 }, /actionsLimit/],
    [{ actionsLimit: 1, tokenLimit: Number.NaN }, /tokenLimit/],
    [{ actionsLimit: Number.POSITIVE_INFINITY, tokenLimit: 100 }, /actionsLimit/],
  ])('rejects invalid limits %j (#1308)', (config, message) => {
    expect(() => new BudgetTracker(config)).toThrow(message);
  });
});
