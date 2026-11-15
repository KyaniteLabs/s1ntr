import { afterEach, describe, expect, it, vi } from 'vitest';

describe('SinterMemoryProfile', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('is silent and starts no timer when profiling is off', async () => {
    vi.stubEnv('SINTER_PROFILE_MEMORY', '');
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    vi.resetModules();
    const mod = await import('../../../src/telemetry/SinterMemoryProfile.js');
    mod.setSinterMemoryStage('render');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('emits one stderr line per second tagged with the current stage when enabled', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SINTER_PROFILE_MEMORY', '1');
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true; }) as never);
    vi.resetModules();
    const mod = await import('../../../src/telemetry/SinterMemoryProfile.js');

    vi.advanceTimersByTime(1000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[sinter-memory\] elapsedMs=1000 stage=startup rssMiB=\d+ heapUsedMiB=\d+ externalMiB=\d+ arrayBuffersMiB=\d+\n$/);

    mod.setSinterMemoryStage('judge');
    vi.advanceTimersByTime(1000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/elapsedMs=2000 stage=judge /);
  });

  it('ignores stage changes while profiling is off, so the stage stays "startup"', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SINTER_PROFILE_MEMORY', '1');
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { lines.push(String(s)); return true; }) as never);
    vi.resetModules();
    const mod = await import('../../../src/telemetry/SinterMemoryProfile.js');
    vi.stubEnv('SINTER_PROFILE_MEMORY', '0');
    mod.setSinterMemoryStage('ignored');
    vi.advanceTimersByTime(1000);
    expect(lines[0]).toContain('stage=startup');
  });
});
