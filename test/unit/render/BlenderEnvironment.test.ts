import { describe, expect, it } from 'vitest';
import { smokeEnvironmentFailure, smokeRuntimeErrors } from '../../../src/runtime-core/SmokeFrameCheck.js';

describe('smoke gate on a Blender render', () => {
  it('stops generation on an unusable Blender instead of scoring it as a bad piece', () => {
    const smoke = { success: false, errors: ['Blender executable not found: "blender"'], pageErrors: [], failureKind: 'binary-missing' };
    expect(smokeEnvironmentFailure(smoke)).toContain('Blender executable not found');
    expect(smokeEnvironmentFailure({ ...smoke, failureKind: 'sandbox-unavailable' })).toBe('Blender executable not found: "blender"');
  });
  it('sends a bpy script failure to the repair turn', () => {
    const smoke = { success: false, errors: ['Blender exited with code 1:\nAttributeError: no teapot'], pageErrors: [], failureKind: 'script' };
    expect(smokeEnvironmentFailure(smoke)).toBeNull();
    expect(smokeRuntimeErrors(smoke)).toEqual(['Blender exited with code 1:\nAttributeError: no teapot']);
    expect(smokeRuntimeErrors({ ...smoke, failureKind: 'no-output' })).toHaveLength(1);
  });
  it('keeps a Blender timeout out of the repair', () => {
    expect(smokeRuntimeErrors({ success: false, errors: ['timed out'], pageErrors: [], failureKind: 'timeout' })).toEqual([]);
  });
});
