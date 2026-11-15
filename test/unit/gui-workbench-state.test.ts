import { describe, expect, it } from 'vitest';
import { getWorkbenchMode, shouldRenderLegacyPanel, WORKBENCH_MODES } from '../../gui/src/gui/workbenchState';

describe('workbenchState', () => {
  it('maps old tabs into unified workbench modes', () => {
    expect(getWorkbenchMode('create').id).toBe('generate');
    expect(getWorkbenchMode('cockpit').id).toBe('generate');
    expect(getWorkbenchMode('liveMusic').id).toBe('generate');
    expect(getWorkbenchMode('improve').id).toBe('improve');
    expect(getWorkbenchMode('live').id).toBe('review');
    expect(getWorkbenchMode('curator').id).toBe('review');
    expect(getWorkbenchMode('compost').id).toBe('evolve');
    expect(getWorkbenchMode('activity').id).toBe('observe');
    expect(getWorkbenchMode('config').id).toBe('settings');
    expect(WORKBENCH_MODES.map((mode) => mode.id)).toEqual([
      'generate',
      'campaign',
      'showcase',
      'settings',
      'improve',
      'review',
      'evolve',
      'observe',
    ]);
  });

  it('makes Create the front door, Gallery + Settings the user surface, operator modes flagged', () => {
    expect(WORKBENCH_MODES[0]).toMatchObject({ id: 'generate', label: 'Create' });
    expect(WORKBENCH_MODES[1]).toMatchObject({ id: 'campaign', label: 'Campaign' });
    expect(WORKBENCH_MODES[2]).toMatchObject({ id: 'showcase', label: 'Gallery' });
    expect(getWorkbenchMode('unknown-tab')).toMatchObject({ id: 'generate' });
    // The engine's surfaces are flagged operator and hidden from the user GUI.
    expect(WORKBENCH_MODES.filter((mode) => mode.operator).map((mode) => mode.id))
      .toEqual(['improve', 'review', 'evolve', 'observe']);
  });

  it('keeps primary generate out of the legacy panel while preserving migration panels', () => {
    expect(shouldRenderLegacyPanel('create')).toBe(false);
    expect(shouldRenderLegacyPanel('cockpit')).toBe(true);
    expect(shouldRenderLegacyPanel('liveMusic')).toBe(true);
    expect(shouldRenderLegacyPanel('improve')).toBe(false);
    expect(shouldRenderLegacyPanel('curator')).toBe(true);
    expect(shouldRenderLegacyPanel('config')).toBe(true);
  });
});
