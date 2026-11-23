import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIE_BAND, LoopReplayIntegrityError, parseLoopsFlag, runGovernedLoops, loopFolder } from '../../../src/cli/LiminalProductionLoops.js';
import { loadPriorRun } from '../../../src/generators/revision/RevisionBrief.js';

/** Writes what a completed governed Create leaves in its -o folder (projection + source.txt + frames). */
function complete(root: string, code: string, score: number, reasoning: string) {
  const op = 'op-' + code.length + '-' + score;
  const dir = path.join(root, 'artifacts', createHash('sha256').update(op).digest('hex'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'source.txt'), code);
  writeFileSync(path.join(root, 'product-projections.json'),
    JSON.stringify({ k: { kind: 'create', result: { operationId: op, evaluation: { score, reasoning, admissionEligible: score !== null } } } }));
}

describe('runGovernedLoops', () => {
  it('rejects bad --loops values', () => {
    expect(parseLoopsFlag('3')).toBe(3);
    for (const v of ['0', '-1', 'x', '2.5', '99']) expect(() => parseLoopsFlag(v)).toThrow(/--loops/);
  });

  it('sends a first-draft failure to the next draft even without saved code', async () => {
    const prompts: string[] = [];
    await runGovernedLoops({
      request: 'Paint a river', domain: 'compose', loops: 2, providerCallsPerLoop: 2,
      generateOne: async ({ prompt, loop }) => {
        prompts.push(prompt);
        if (loop === 1) throw new Error('GLSL: helper declaration rejected');
        return { providerCalls: 1, score: null, critique: '' };
      },
    });
    expect(prompts[0]).toBe('Paint a river');
    expect(prompts[1]).toContain('Paint a river');
    expect(prompts[1]).toContain('GLSL: helper declaration rejected');
  });

  it('scrubs paths and URLs before carrying a capped runtime error into the next prompt', async () => {
    const prompts: string[] = [];
    const address = new URL('file:///private/item');
    await runGovernedLoops({ request: 'a field', domain: 'p5', loops: 2, providerCallsPerLoop: 1,
      generateOne: async ({ loop, prompt }) => {
        prompts.push(prompt);
        if (loop === 1) throw new Error(`READ_FAILED "/private/staging area/item" C:\\work\\item ${address} ${'x'.repeat(2000)}`);
        return { providerCalls: 1, score: null, critique: '' };
      } });
    const carried = prompts[1].slice(prompts[1].indexOf('READ_FAILED'));
    expect(carried).toContain('READ_FAILED');
    expect(carried).not.toMatch(/private|staging|work|item|example/);
    expect(carried).toMatch(/\[path\].*\[path\].*\[url\]/i);
    expect(carried).toHaveLength(1500);
  });

  it('reuses the original paid refinement after an interruption and refuses a changed request', async () => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), 'loops-replay-'));
    const paid = new Set<string>();
    const received: string[] = [];
    const options = { request: 'A river', domain: 'compose', loops: 2, providerCallsPerLoop: 2,
      outputRoot, checkpointBeforeEffects: true };
    const firstError = 'GLSL: helper declaration rejected';
    try {
      await expect(runGovernedLoops({ ...options, generateOne: async ({ loop, prompt, attemptId }) => {
        paid.add(attemptId + '\0' + prompt);
        if (loop === 1) throw new Error(firstError);
        received.push(prompt);
        throw new LoopReplayIntegrityError('interrupted before loop checkpoint');
      } })).rejects.toThrow('interrupted before loop checkpoint');

      const checkpoint = path.join(outputRoot, 'loops-manifest.json');
      const original = readFileSync(checkpoint, 'utf8');
      writeFileSync(checkpoint, original.replace(firstError, 'EFFECT_OUTCOME_UNRESOLVED'));
      const resume = () => runGovernedLoops({ ...options, generateOne: async ({ loop, prompt, attemptId }) => {
        expect(loop).toBe(2);
        expect(paid.has(attemptId + '\0' + prompt)).toBe(true);
        received.push(prompt);
        return { providerCalls: 0, score: null, critique: '' };
      } });
      await expect(resume()).rejects.toThrow('LOOPS_RESUME_REQUEST_MISMATCH');
      expect(received).toHaveLength(1);
      writeFileSync(checkpoint, original);

      const completed = await resume();
      expect(received).toEqual([received[0], received[0]]);
      expect(completed.manifest.records.map(record => record.status)).toEqual(['failed', 'ok']);
      expect(completed.manifest.providerCallsUnverified).toBe(2);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it.each(['unreadable', 'unbound'])('stops before dispatch for an %s earlier request', async (state) => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), 'loops-binding-'));
    try {
      const loopDir = loopFolder(outputRoot, 1);
      mkdirSync(loopDir, { recursive: true });
      const request = path.join(loopDir, 'request.txt');
      if (state === 'unreadable') {
        mkdirSync(request);
        writeFileSync(request + '.binding.json', 'present');
      } else {
        writeFileSync(request, 'a river');
      }
      const calls: number[] = [];
      await expect(runGovernedLoops({ request: 'a river', domain: 'html', loops: 2, providerCallsPerLoop: 2,
        outputRoot, checkpointBeforeEffects: true, generateOne: async ({ loop }) => {
          calls.push(loop);
          return { providerCalls: 1, score: null, critique: '' };
        } })).rejects.toThrow('LOOP_RECOVERY_INTEGRITY');
      expect(calls).toEqual([]);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('refuses a pending pre-upgrade run after its per-loop folder was lost', async () => {
    const outputRoot = mkdtempSync(path.join(tmpdir(), 'loops-legacy-'));
    const brief = { request: 'a river', domain: 'html', loops: 2, providerCallsPerLoop: 2 };
    try {
      writeFileSync(path.join(outputRoot, 'loops-manifest.json'), JSON.stringify({
        ...brief, schema: 's1ntr-loops/1', records: [], bestLoop: null, providerCallsConsumed: 0,
        providerCallBudget: 4, tieBand: DEFAULT_TIE_BAND,
      }));
      await expect(runGovernedLoops({ ...brief, outputRoot, verifyResumedCreates: true,
        generateOne: async () => { throw new Error('unexpected provider call'); } }))
        .rejects.toThrow('LOOPS_UNBOUND_PRIOR_RUN');
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('a failed loop carries the last good code plus the error text; best is marked; resume skips done loops', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-unit-'));
    try {
      const prompts: string[] = [];
      const gen = (failLoop: number) => async (a: { prompt: string; outputRoot: string; loop: number }) => {
        prompts.push(a.prompt);
        if (a.loop === failLoop) throw new Error('RENDER_BOOM: canvas never painted');
        complete(a.outputRoot, `code-of-loop-${a.loop}`, a.loop === 1 ? 0.8 : 0.5, `critique-${a.loop}`);
        return { score: a.loop === 1 ? 0.8 : 0.5, critique: `critique-${a.loop}`, providerCalls: 2 };
      };
      const first = await runGovernedLoops({ request: 'req', domain: 'html', loops: 3, outputRoot: out, providerCallsPerLoop: 2, generateOne: gen(2) });
      expect(first.manifest.records.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
      expect(prompts[2]).toContain('code-of-loop-1');
      expect(prompts[2]).toContain('LOOP 2 FAILED');
      expect(prompts[2]).toContain('RENDER_BOOM');
      expect(first.bestLoop).toBe(1);
      expect(first.manifest.providerCallBudget).toBe(6);
      expect(first.manifest.providerCallsConsumed).toBe(4);
      const checkpoint = path.join(out, 'loops-manifest.json');
      await expect(runGovernedLoops({ request: 'req', domain: 'html', loops: 3, outputRoot: out,
        providerCallsPerLoop: 2, generateOne: async (attempt) => {
          expect(attempt.loop).toBe(2);
          throw new LoopReplayIntegrityError(new Error('invalid persisted Create'));
        } })).rejects.toThrow('invalid persisted Create');
      const afterInterruptedResume = JSON.parse(readFileSync(checkpoint, 'utf8')) as typeof first.manifest;
      expect(afterInterruptedResume.records[2].winningAttempt).toEqual(first.manifest.records[2].winningAttempt);

      // crash/resume: loops 1 and 3 are complete on disk and are not re-run; only loop 2 runs again
      prompts.length = 0;
      const again = await runGovernedLoops({ request: 'req', domain: 'html', loops: 3, outputRoot: out, providerCallsPerLoop: 2, generateOne: gen(99) });
      expect(again.manifest.records.map((r) => r.status)).toEqual(['resumed', 'ok', 'resumed']);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('code-of-loop-1');
      expect(loopFolder(out, 2)).toContain(path.join('loops', 'r2'));
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  const CRIT1 = 'Strong, brief-true glitch: a face genuinely forms and the palette is exactly on-brief. Concrete weaknesses: (1) the top 12% of both frames is dead black with no signal activity; (2) motion is single-axis.';
  const prog = (tag: string, n = 20) => Array.from({ length: n }, (_, i) => `line ${i} ${tag}`).join('\n');

  it('a no-op reply (>90% identical lines) is a failed attempt and is asked again once with that fact stated', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-noop-'));
    try {
      const sent: Array<{ prompt: string; attemptId: string; providerCallsMaximum: number; replayOnly?: boolean }> = [];
      const first = prog('A');
      const gen = async (a: { prompt: string; outputRoot: string; loop: number; attemptId: string; providerCallsMaximum: number; replayOnly?: boolean }) => {
        sent.push({ prompt: a.prompt, attemptId: a.attemptId, providerCallsMaximum: a.providerCallsMaximum, replayOnly: a.replayOnly });
        if (a.replayOnly) return { score: a.loop === 1 ? 0.7 : 0.8, critique: 'journaled retry',
          providerCalls: 0, prior: loadPriorRun(a.outputRoot) };
        // loop 2 first answers with the same code (a no-op), then really changes it on the retry
        const code = a.loop === 1 ? first : a.attemptId.endsWith('-noop') ? prog('B', 8) + '\n' + first.split('\n').slice(0, 6).join('\n') : first + '\n// tweak';
        complete(a.outputRoot, code, a.loop === 1 ? 0.7 : 0.8, a.loop === 1 ? CRIT1 : 'ok');
        return { score: a.loop === 1 ? 0.7 : 0.8, critique: a.loop === 1 ? CRIT1 : 'ok', providerCalls: 1 };
      };
      const run = await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: out, providerCallsPerLoop: 4, generateOne: gen });
      expect(sent.map((x) => x.attemptId)).toEqual(['loop1of2', 'loop2of2', 'loop2of2-noop']);
      expect(sent.map((x) => x.providerCallsMaximum)).toEqual([4, 4, 3]);
      expect(sent[1].prompt).not.toContain('REJECTED');
      expect(sent[2].prompt).toContain('YOUR PREVIOUS REPLY TO THIS LOOP WAS REJECTED');
      expect(sent[2].prompt).toMatch(/9\d% identical|100% identical/);
      const r2 = run.manifest.records[1];
      expect(r2.noOpRetried).toBe(true);
      expect(r2.noOpPersisted).toBe(false);
      expect(r2.providerCalls).toBe(2);
      expect(run.manifest.providerCallsConsumed).toBe(3);

      const retryPrompt = sent[2].prompt;
      sent.length = 0;
      const resumed = await runGovernedLoops({
        request: 'req', domain: 'html', loops: 2, outputRoot: out,
        providerCallsPerLoop: 4, verifyResumedCreates: true, generateOne: gen,
      });
      expect(resumed.manifest.records.map((r) => r.status)).toEqual(['resumed', 'resumed']);
      expect(resumed.manifest.providerCallsConsumed).toBe(0);
      expect(resumed.best?.critique).toBe('journaled retry');
      expect(sent).toEqual([{
        prompt: 'req', attemptId: 'loop1of2', providerCallsMaximum: 4, replayOnly: true,
      }, {
        prompt: retryPrompt, attemptId: 'loop2of2-noop', providerCallsMaximum: 3, replayOnly: true,
      }]);
      await expect(runGovernedLoops({
        request: 'new request', domain: 'html', loops: 2, outputRoot: out,
        providerCallsPerLoop: 4, generateOne: gen,
      })).rejects.toThrow('LOOPS_RESUME_REQUEST_MISMATCH');
      expect(sent).toHaveLength(2);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('a reply more than 1.25x as long as the code it edits is asked again once to replace, not add; the shorter reply is kept', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-bloat-'));
    try {
      const sent: Array<{ prompt: string; attemptId: string }> = [];
      const first = prog('A');
      const gen = async (a: { prompt: string; outputRoot: string; loop: number; attemptId: string }) => {
        sent.push({ prompt: a.prompt, attemptId: a.attemptId });
        // loop 2 first piles on layers (3x the lines), then comes back at the same size on the retry
        const code = a.loop === 1 ? first : a.attemptId.endsWith('-bloat') ? prog('C', 22) : prog('B', 60);
        complete(a.outputRoot, code, a.loop === 1 ? 0.8 : 0.78, a.loop === 1 ? CRIT1 : 'ok');
        return { score: a.loop === 1 ? 0.8 : 0.78, critique: a.loop === 1 ? CRIT1 : 'ok', providerCalls: 1 };
      };
      const run = await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: out, providerCallsPerLoop: 4, generateOne: gen });
      expect(sent.map((x) => x.attemptId)).toEqual(['loop1of2', 'loop2of2', 'loop2of2-bloat']);
      expect(sent[1].prompt).not.toContain('REJECTED');
      expect(sent[2].prompt).toContain('YOUR PREVIOUS REPLY TO THIS LOOP WAS REJECTED');
      expect(sent[2].prompt).toContain('3.0x as long');
      expect(sent[2].prompt).toContain('125% the length');
      const r2 = run.manifest.records[1];
      expect(r2.bloatRetried).toBe(true);
      expect(r2.bloatPersisted).toBe(false);
      expect(r2.lineGrowth).toBeCloseTo(1.1, 5);
      expect(r2.providerCalls).toBe(2);
      expect(run.manifest.records[0].lineGrowth).toBeNull();
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('a revision at or under 1.25x is not re-asked', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-nobloat-'));
    try {
      const sent: string[] = [];
      const gen = async (a: { prompt: string; outputRoot: string; loop: number; attemptId: string }) => {
        sent.push(a.attemptId);
        complete(a.outputRoot, a.loop === 1 ? prog('A') : prog('B', 25), 0.7, 'ok');
        return { score: 0.7, critique: 'ok', providerCalls: 1 };
      };
      const run = await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: out, providerCallsPerLoop: 4, generateOne: gen });
      expect(sent).toEqual(['loop1of2', 'loop2of2']);
      expect(run.manifest.records[1].bloatRetried).toBeUndefined();
      expect(run.manifest.records[1].lineGrowth).toBeCloseTo(1.25, 5);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('the revision request names the weakest thing, keeps the praised part, states the loop number and "surpass"', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-brief-'));
    try {
      const sent: string[] = [];
      const gen = async (a: { prompt: string; outputRoot: string; loop: number }) => {
        sent.push(a.prompt);
        complete(a.outputRoot, prog('L' + a.loop), 0.7, CRIT1);
        return { score: 0.7, critique: CRIT1, providerCalls: 1 };
      };
      await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: out, providerCallsPerLoop: 2, generateOne: gen });
      const p = sent[1];
      expect(p).toContain('This is loop 2 of 2');
      expect(p).toContain('SURPASS');
      expect(p).toMatch(/THE WEAKEST THING THE JUDGE SAW: "\(1\) the top 12% of both frames is dead black/);
      expect(p).toMatch(/KEEP WHAT THE JUDGE PRAISED: "Strong, brief-true glitch/);
      expect(p).toContain('more than 90% identical');
      expect(p).not.toMatch(/60%/);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('when loop k scored lower, loop k+1 edits the BEST loop and carries the lower attempt\'s critique as "scored lower, because"', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-best-'));
    try {
      const sent: string[] = [];
      const scores = [0.84, 0.6, 0.9];
      const gen = async (a: { prompt: string; outputRoot: string; loop: number }) => {
        sent.push(a.prompt);
        const crit = a.loop === 2 ? 'The face bloated into mush: LOSING-DIRECTION-CRITIQUE.' : CRIT1;
        complete(a.outputRoot, prog('L' + a.loop), scores[a.loop - 1], crit);
        return { score: scores[a.loop - 1], critique: crit, providerCalls: 1 };
      };
      const run = await runGovernedLoops({ request: 'req', domain: 'html', loops: 3, outputRoot: out, providerCallsPerLoop: 2, generateOne: gen });
      expect(sent[2]).toContain('line 3 L1');            // the best loop's code, not loop 2's
      expect(sent[2]).not.toContain('line 3 L2');
      expect(sent[2]).toContain('Loop 2 tried a different direction and scored 0.60, lower');
      expect(sent[2]).toContain('LOSING-DIRECTION-CRITIQUE');
      expect(run.manifest.records[2].editedFromLoop).toBe(1);
      expect(run.bestLoop).toBe(3);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('best-of uses a judge-noise tie band: a later loop must beat the best by more than the band', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-band-'));
    try {
      const scores = [0.8, 0.82, 0.9];
      const gen = async (a: { outputRoot: string; loop: number }) => { complete(a.outputRoot, prog('L' + a.loop), scores[a.loop - 1], 'c'); return { score: scores[a.loop - 1], critique: 'c', providerCalls: 1 }; };
      const run = await runGovernedLoops({ request: 'req', domain: 'html', loops: 3, outputRoot: out, providerCallsPerLoop: 2, tieBand: 0.05, generateOne: gen });
      expect(run.bestLoop).toBe(3);                       // 0.90 clears 0.80 + 0.05
      const tied = await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: mkdtempSync(path.join(tmpdir(), 'loops-band2-')), providerCallsPerLoop: 2, tieBand: 0.05, generateOne: gen });
      expect(tied.bestLoop).toBe(1);                      // 0.82 is inside the band: the earlier loop keeps it
      expect(run.manifest.tieBand).toBe(0.05);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('replays each completed loop before using it and retains the best payload', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'loops-replay-'));
    try {
      const calls: number[] = [];
      const gen = async (a: { outputRoot: string; loop: number }) => { calls.push(a.loop); complete(a.outputRoot, prog('L' + a.loop), 0.7, 'c'); return { score: 0.7, critique: 'c', providerCalls: 0, payload: a.loop, prior: loadPriorRun(a.outputRoot) }; };
      await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: out, providerCallsPerLoop: 2, generateOne: gen });
      calls.length = 0;
      const again = await runGovernedLoops({ request: 'req', domain: 'html', loops: 2, outputRoot: out, providerCallsPerLoop: 2, verifyResumedCreates: true, generateOne: gen });
      expect(again.manifest.records.map((r) => r.status)).toEqual(['resumed', 'resumed']);
      expect(calls).toEqual([1, 2]);
      expect(again.best?.payload).toBe(1);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('in-memory loops (chat/TUI/GUI: no run folder) never resume, so the best loop always has its payload', async () => {
    const gen = async (a: { loop: number }) => ({ score: 0.5 + a.loop / 10, critique: 'c', providerCalls: 1, payload: 'p' + a.loop, prior: { source: prog('M' + a.loop), score: 0.5 + a.loop / 10, critique: 'c', rejectionReasons: [], frames: [], artifactDirectory: '' } });
    const run = await runGovernedLoops({ request: 'req', domain: 'html', loops: 3, providerCallsPerLoop: 2, generateOne: gen });
    expect(run.manifest.records.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(run.best?.payload).toBe('p3');
  });
});
