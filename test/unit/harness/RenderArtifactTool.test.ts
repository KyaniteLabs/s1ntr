import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

import { RenderArtifactTool } from '../../../src/harness/tools/RenderArtifactTool.js';
import type { RenderEvidence } from '../../../src/core/types/GenerationEvaluation.js';

function evidence(overrides: Partial<RenderEvidence> = {}): RenderEvidence {
  return {
    timingMs: 42,
    infraUnavailable: false,
    candidateFailure: false,
    screenshot: {
      mimeType: 'image/png',
      dataBase64: 'QUJD',
      width: 800,
      height: 600,
    },
    logs: ['[log] rendered'],
    errors: [],
    ...overrides,
  };
}

describe('RenderArtifactTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders inline code and returns the screenshot evidence', async () => {
    const renderer = { renderWithEvidence: vi.fn(async () => evidence()) };
    const tool = new RenderArtifactTool(renderer as never);

    const result = await tool.execute({ code: '<html><body>hi</body></html>', domain: 'html' });

    expect(result.success).toBe(true);
    expect(renderer.renderWithEvidence).toHaveBeenCalledOnce();
    const [code, options] = renderer.renderWithEvidence.mock.calls[0] as [string, { domain?: string }];
    expect(code).toContain('<html>');
    expect(options.domain).toBe('html');
    expect(result.data?.screenshot?.dataBase64).toBe('QUJD');
    expect(result.data?.candidateFailure).toBe(false);
    expect(result.data?.logs).toEqual(['[log] rendered']);
  });

  it('reads artifact code from an allowed repo path', async () => {
    mockReadFile.mockResolvedValue('function setup() { createCanvas(100, 100); }');
    const renderer = { renderWithEvidence: vi.fn(async () => evidence()) };
    const tool = new RenderArtifactTool(renderer as never);

    const result = await tool.execute({ path: 'output/sketch.js' });

    expect(result.success).toBe(true);
    expect(mockReadFile).toHaveBeenCalledOnce();
    const [code] = renderer.renderWithEvidence.mock.calls[0] as [string];
    expect(code).toContain('createCanvas');
  });

  it('rejects a path outside the allowed project surfaces', async () => {
    const renderer = { renderWithEvidence: vi.fn(async () => evidence()) };
    const tool = new RenderArtifactTool(renderer as never);

    const result = await tool.execute({ path: '../../etc/passwd' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Path not allowed');
    expect(renderer.renderWithEvidence).not.toHaveBeenCalled();
  });

  it('requires exactly one of code or path', async () => {
    const renderer = { renderWithEvidence: vi.fn(async () => evidence()) };
    const tool = new RenderArtifactTool(renderer as never);

    const neither = await tool.execute({});
    expect(neither.success).toBe(false);
    expect(neither.error).toContain('exactly one');

    const both = await tool.execute({ code: 'x', path: 'output/y.js' });
    expect(both.success).toBe(false);
    expect(both.error).toContain('exactly one');
    expect(renderer.renderWithEvidence).not.toHaveBeenCalled();
  });

  it('rejects an unknown render domain', async () => {
    const renderer = { renderWithEvidence: vi.fn(async () => evidence()) };
    const tool = new RenderArtifactTool(renderer as never);

    const result = await tool.execute({ code: 'x', domain: 'webgl9000' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown render domain');
    expect(renderer.renderWithEvidence).not.toHaveBeenCalled();
  });

  it('fails loudly when render infrastructure is unavailable', async () => {
    const renderer = {
      renderWithEvidence: vi.fn(async () => evidence({ infraUnavailable: true, screenshot: undefined })),
    };
    const tool = new RenderArtifactTool(renderer as never);

    const result = await tool.execute({ code: 'x' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('infrastructure unavailable');
    expect(result.data?.infraUnavailable).toBe(true);
  });

  it('reports candidate render failures as successful tool executions with error evidence', async () => {
    const renderer = {
      renderWithEvidence: vi.fn(async () => evidence({
        candidateFailure: true,
        screenshot: undefined,
        errors: ['ReferenceError: foo is not defined'],
        logs: ['[error] ReferenceError: foo is not defined'],
      })),
    };
    const tool = new RenderArtifactTool(renderer as never);

    const result = await tool.execute({ code: 'foo();' });

    expect(result.success).toBe(true);
    expect(result.data?.candidateFailure).toBe(true);
    expect(result.data?.errors).toContain('ReferenceError: foo is not defined');
  });

  it('clamps viewport and timeout parameters to safe bounds', async () => {
    const renderer = { renderWithEvidence: vi.fn(async () => evidence()) };
    const tool = new RenderArtifactTool(renderer as never);

    await tool.execute({ code: 'x', width: 99999, height: 1, timeout: 5 });

    const [, options] = renderer.renderWithEvidence.mock.calls[0] as [string, { width: number; height: number; timeout: number }];
    expect(options.width).toBe(4096);
    expect(options.height).toBe(16);
    expect(options.timeout).toBe(1000);
  });
});
