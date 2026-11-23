import { beforeEach, describe, expect, it, vi } from 'vitest';

const { renderBlenderMock } = vi.hoisted(() => ({ renderBlenderMock: vi.fn() }));

vi.mock('../../../src/render/BlenderRenderer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/render/BlenderRenderer.js')>()),
  renderBlender: renderBlenderMock,
}));

import { HeadlessRenderer } from '../../../src/render/HeadlessRenderer.js';
import { RenderAndScorePipeline } from '../../../src/render/RenderAndScorePipeline.js';

const SCRIPT = 'import bpy\nbpy.ops.mesh.primitive_cube_add()\n';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('HeadlessRenderer blender delegation', () => {
  beforeEach(() => renderBlenderMock.mockReset());

  it('turns a successful blender render into screenshot evidence without launching a browser', async () => {
    renderBlenderMock.mockResolvedValue({ success: true, png: PNG, width: 640, height: 360, logs: ['done'] });
    const renderer = new HeadlessRenderer();
    const initialize = vi.spyOn(renderer, 'initialize');

    const result = await renderer.render(SCRIPT, { domain: 'blender', hardDeadlineMs: 7_123 });

    expect(renderBlenderMock).toHaveBeenCalledTimes(1);
    expect(renderBlenderMock).toHaveBeenCalledWith(SCRIPT, { timeoutMs: 7_123 });
    expect(initialize).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.rendered).toBe(true);
    expect(result.screenshot).toEqual({ buffer: PNG, width: 640, height: 360, success: true });
    expect(result.lateScreenshot?.buffer).toBe(PNG);
    expect(result.logs).toEqual(['done']);
  });

  it('a bwrap render is contained; an unsandboxed one is not (#1628)', async () => {
    renderBlenderMock.mockResolvedValue({ success: true, png: PNG, width: 640, height: 360, logs: [], sandbox: 'bwrap' });
    const isolated = await new HeadlessRenderer().render(SCRIPT, { domain: 'blender' });
    expect(isolated.containment).toMatchObject({ networkIsolated: true, permissionsDenied: true,
      cleanupSucceeded: true, timeoutEnforced: true, outputBytes: Buffer.byteLength(SCRIPT) });

    renderBlenderMock.mockResolvedValue({ success: true, png: PNG, width: 640, height: 360, logs: [], sandbox: 'none' });
    const open = await new HeadlessRenderer().render(SCRIPT, { domain: 'blender' });
    expect(open.containment?.networkIsolated).toBe(false);
    expect(open.containment?.permissionsDenied).toBe(false);
  });

  it('carries the failure kind through, so a missing binary is not mistaken for a bad script', async () => {
    renderBlenderMock.mockResolvedValue({ success: false, failureKind: 'binary-missing', error: 'Blender executable not found: "blender"', logs: [] });
    const result = await new HeadlessRenderer().render(SCRIPT, { domain: 'blender' });
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe('binary-missing');
  });

  it('a bad script is a candidate failure the judge sees, not infrastructure', async () => {
    renderBlenderMock.mockResolvedValue({
      success: false, failureKind: 'script', logs: [],
      error: 'Blender script exited with code 1: NameError: name \'cube\' is not defined',
    });

    const evidence = await new HeadlessRenderer().renderWithEvidence(SCRIPT, { domain: 'blender' });

    expect(evidence.candidateFailure).toBe(true);
    expect(evidence.infraUnavailable).toBe(false);
  });

  it('a timeout is a candidate failure', async () => {
    renderBlenderMock.mockResolvedValue({
      success: false, failureKind: 'timeout', logs: [], error: 'Blender render timed out after 90000ms',
    });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCRIPT, { domain: 'blender' });
    expect(evidence.candidateFailure).toBe(true);
    expect(evidence.infraUnavailable).toBe(false);
  });

  it('empty output (no PNG) is a failure with no screenshot', async () => {
    renderBlenderMock.mockResolvedValue({
      success: false, failureKind: 'no-output', logs: [], error: 'Blender produced no PNG',
    });
    const result = await new HeadlessRenderer().render(SCRIPT, { domain: 'blender' });
    expect(result.success).toBe(false);
    expect(result.screenshot).toBeUndefined();
    expect(result.errors).toEqual(['Blender produced no PNG']);
  });

  it('a missing blender binary is infrastructure unavailable, not a candidate failure', async () => {
    renderBlenderMock.mockResolvedValue({
      success: false, failureKind: 'binary-missing', logs: [],
      error: 'Blender executable not found: "blender". Install Blender or set SINTER_BLENDER_BIN.',
    });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCRIPT, { domain: 'blender' });
    expect(evidence.infraUnavailable).toBe(true);
    expect(evidence.candidateFailure).toBe(false);
  });

  it('a missing OS sandbox is infrastructure unavailable, not a candidate failure', async () => {
    renderBlenderMock.mockResolvedValue({
      success: false, failureKind: 'sandbox-unavailable', logs: [],
      error: 'Blender sandbox unavailable: bwrap (bubblewrap) executable not found. Model-written Python will not run on the host without an OS sandbox.',
    });
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCRIPT, { domain: 'blender' });
    expect(evidence.infraUnavailable).toBe(true);
    expect(evidence.candidateFailure).toBe(false);
  });
});

describe('Blender runs only for an explicit blender domain', () => {
  beforeEach(() => renderBlenderMock.mockReset());
  const REFUSED = 'bpy script detected; Blender renders only run for an explicit blender domain';

  it.each([[undefined], ['unknown' as const]])('auto-detected bpy with domain %s is refused, Blender never starts', async (domain) => {
    const renderer = new HeadlessRenderer();
    const initialize = vi.spyOn(renderer, 'initialize');
    const result = await renderer.render(SCRIPT, domain ? { domain } : {});
    expect(result).toEqual({ rendered: false, success: false, error: REFUSED, logs: [], errors: [REFUSED], pageErrors: [] });
    expect(renderBlenderMock).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('renderWithEvidence (RenderArtifactTool / dream observer path) refuses auto-detected bpy', async () => {
    const evidence = await new HeadlessRenderer().renderWithEvidence(SCRIPT, { domain: 'unknown' });
    expect(renderBlenderMock).not.toHaveBeenCalled();
    expect(evidence.rendered).toBe(false);
    expect(evidence.screenshot).toBeUndefined();
    expect(JSON.stringify(evidence)).toContain(REFUSED);
  });

  it('RenderAndScorePipeline.process without a hint does not run Blender', async () => {
    const result = await new RenderAndScorePipeline({ scoreVisual: false, scoreAudio: false }).process(SCRIPT);
    expect(renderBlenderMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe(REFUSED);
  });

  it('RenderAndScorePipeline.process with the blender hint runs Blender', async () => {
    renderBlenderMock.mockResolvedValue({ success: true, png: PNG, width: 640, height: 360, logs: [] });
    const result = await new RenderAndScorePipeline({ scoreVisual: false, scoreAudio: false }).process(SCRIPT, 'blender');
    expect(renderBlenderMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.domain).toBe('blender');
  });
});
