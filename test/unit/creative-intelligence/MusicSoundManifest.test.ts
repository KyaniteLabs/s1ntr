import { describe, expect, it, vi } from 'vitest';
import {
  CREATIVE_PRINCIPLE_MANIFEST,
  MUSIC_SOUND_DISPOSITION_MATRIX,
  MUSIC_SOUND_MANIFEST_SCHEMA,
  MUSIC_SOUND_SOURCE_ROWS,
  compileCreativeThesis,
  musicSoundDispositionFor,
  resolveMusicSoundContract,
} from '../../../src/creative-intelligence/CreativeIntelligence.js';
import { CreativeRunCoordinator, MemoryCreativeRunPersistence } from '../../../src/creative-run/CreativeRunCoordinator.js';

describe('frozen music and sound contract surface', () => {
  it('exhaustively dispositions every frozen source row', () => {
    expect(MUSIC_SOUND_SOURCE_ROWS).toHaveLength(47);
    expect(MUSIC_SOUND_DISPOSITION_MATRIX).toHaveLength(MUSIC_SOUND_SOURCE_ROWS.length);
    expect(new Set(MUSIC_SOUND_SOURCE_ROWS.map((row) => `${row.domain}:${row.name}`)).size).toBe(47);
    for (const entry of MUSIC_SOUND_DISPOSITION_MATRIX) {
      expect(entry.row.source).toBe(MUSIC_SOUND_MANIFEST_SCHEMA);
      expect(entry.row.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.isFrozen(entry)).toBe(true);
      if (entry.disposition === 'supported') {
        expect(entry.contractId).toMatch(/^music-/);
        expect(Object.keys(CREATIVE_PRINCIPLE_MANIFEST.contracts)).toContain(entry.contractId!);
        expect(entry.contractDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.runtimePath).toBe('src/music/generateMusic.ts#generateMusic');
        expect(entry.scenarioIds).toHaveLength(2);
      } else {
        expect(entry.contractId).toBeNull();
        expect(entry.contractDigest).toBe('');
        expect(entry.runtimePath).toBeNull();
        expect(entry.scenarioIds).toEqual([]);
        expect(entry.reason).toMatch(/historical|unsupported/i);
      }
    }
  });

  it('resolves supported aliases and selects dimensions without visual false positives', () => {
    expect(resolveMusicSoundContract('audio dynamics')?.identity.id).toBe('music-dynamics');
    expect(musicSoundDispositionFor('tone color').contractId).toBe('music-timbre');
    expect(compileCreativeThesis('A visual color harmony palette.').principles[0].contractIdentity.principleId).toBe('color-harmony');
    expect(compileCreativeThesis('Audio dynamics with a shaped envelope.').principles[0].contractIdentity.principleId).toBe('music-dynamics');
    expect(compileCreativeThesis('Audio timbre with a shaped waveform.').principles[0].contractIdentity.principleId).toBe('music-timbre');
  });

  it('keeps historical or unsupported requests unreachable', () => {
    const thesis = compileCreativeThesis('Use Sample Manipulation for this music artifact.');
    expect(thesis.disposition).toBe('unsupported');
    expect(thesis.unsupported[0].requested).toBe('sample manipulation');
    expect(resolveMusicSoundContract('sample manipulation')).toBeUndefined();
    expect(compileCreativeThesis('A sample material music artifact.').disposition).toBe('supported');
  });

  it('fails closed for every unsupported frozen row, not only the representative sample row', () => {
    for (const entry of MUSIC_SOUND_DISPOSITION_MATRIX.filter((candidate) => candidate.disposition === 'unsupported')) {
      const thesis = compileCreativeThesis(`Use ${entry.row.name} for this music artifact.`);
      const normalizedRow = entry.row.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      expect(thesis.disposition, entry.row.name).toBe('unsupported');
      expect(thesis.unsupported.map((item) => item.requested), entry.row.name).toContain(normalizedRow);
    }
  });

  it('fails closed before provider reservation for a historical sound row', async () => {
    const reserve = vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
    const coordinator = new CreativeRunCoordinator({
      persistence: new MemoryCreativeRunPersistence(),
      reserveProvider: reserve,
    });
    await expect(coordinator.start({
      entryPoint: 'studio-session',
      requestKey: 'music-unsupported-row',
      prompt: 'Use Sample Manipulation for this music artifact.',
    })).rejects.toThrow(/unsupported|reservation/i);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects every unsupported audio layer before reservation despite a supported composition thesis', async () => {
    for (const domain of ['music', 'tone', 'strudel'] as const) {
      const reserve = vi.fn(async () => ({ id: 'must-not-reserve', status: 'reserved' as const }));
      const coordinator = new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence(), reserveProvider: reserve });
      await expect(coordinator.compose({
        creativeThesis: compileCreativeThesis('Music with a coherent chord harmony.'),
        layers: [{ domain, prompt: 'Use Sample Manipulation for this music artifact.' }],
      }, { requestKey: `unsupported-${domain}` })).rejects.toThrow(/reservation was not attempted/);
      expect(reserve).not.toHaveBeenCalled();
    }
  });

  it('returns composition evidence with one exact thesis identity', async () => {
    const result = await new CreativeRunCoordinator({ persistence: new MemoryCreativeRunPersistence() }).compose({
      title: 'Deterministic music evidence',
      layers: [{ domain: 'music', prompt: 'A theory-aware music pulse with chord movement, expressive dynamics, and shaped timbre.' }],
    }, { requestKey: 'music-supported-composition', entryPoint: 'cli-compose' });
    const evidence = result.audioEvidence?.[0];
    expect(evidence?.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.layers[0].artifactHtml).toContain(`data-artifact-digest="${evidence!.artifactDigest}"`);
    expect(result.audioEvidence?.[0]?.provenance.runtimeId).toBe(evidence!.provenance.runtimeId);
    expect(result.creativeRun.creativeThesis?.thesisId).toBe(result.creativeThesis?.thesisId);
    expect(result.creativeRun.readiness.source).toBe('synthetic-no-spend');
  });
});
