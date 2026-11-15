import { describe, expect, it } from 'vitest';
import { PromptLibrary } from '../../../src/prompts/PromptLibrary.js';
import '../../../src/prompts/collab-internal.js';

const COLLAB_IDS = [
  'collab.role.creator', 'collab.role.visionary', 'collab.role.technical-critic', 'collab.role.artistic-critic',
  'collab.role.domain-expert', 'collab.role.integrator', 'collab.role.refiner',
  'collab.synthesis', 'collab.scoring', 'collab.analysis', 'collab.refine',
  'collab.generation', 'collab.generation.alternative',
];

describe('collab-internal registration', () => {
  it('registers all 13 collaboration prompts plus the heuristic evaluator persona on import', () => {
    const collab = PromptLibrary.listByCategory('collab').map(t => t.id).sort();
    expect(collab).toEqual([...COLLAB_IDS].sort());
    expect(PromptLibrary.get('eval.heuristic-persona')).toMatchObject({ category: 'evaluation', version: '2.0.0' });
  });

  it('pins versions (the three analysis critics are 2.2.0, the rest 2.0.0) and requires a system prompt', () => {
    const critics = ['collab.role.technical-critic', 'collab.role.artistic-critic', 'collab.role.domain-expert'];
    const versions = Object.fromEntries(COLLAB_IDS.map(id => [id, PromptLibrary.get(id)!.version]));
    const expected = Object.fromEntries(COLLAB_IDS.map(id => [id, critics.includes(id) ? '2.2.0' : '2.0.0']));
    expect(versions).toEqual(expected);
    expect(COLLAB_IDS.filter(id => PromptLibrary.get(id)!.systemPrompt.trim() === '')).toEqual([]);
  });

  it('rejects registering the same id twice, so module reloads cannot silently overwrite', () => {
    const existing = PromptLibrary.get('collab.generation')!;
    expect(() => PromptLibrary.register(existing)).toThrow('Prompt template already registered: collab.generation');
  });

  it('records the DeepCollaboration phase on the creator and visionary roles', () => {
    expect(PromptLibrary.get('collab.role.creator')!.metadata).toEqual({ role: 'creator', phase: 'divergence' });
    expect(PromptLibrary.get('collab.synthesis')!.metadata).toEqual({ usage: 'phaseDivergence' });
  });
});

describe('collab prompt rendering', () => {
  it('fills prompt and domain into the creator template', () => {
    const { system, user } = PromptLibrary.render('collab.role.creator', { prompt: 'a spiral', domain: 'p5' });
    expect(system.startsWith('You are a CREATOR.')).toBe(true);
    expect(user.startsWith('Request: a spiral\n\nDomain: p5\n')).toBe(true);
    expect(user).not.toContain('${');
  });

  it('fills both outputs and the request into the synthesis template', () => {
    const { user } = PromptLibrary.render('collab.synthesis', {
      creatorOutput: 'CODE-A', visionaryOutput: 'CODE-B', prompt: 'a spiral',
    });
    expect(user).toContain('CREATOR (Practical, technical):\nCODE-A');
    expect(user).toContain('VISIONARY (Creative, artistic):\nCODE-B');
    expect(user).toContain('Original request: a spiral');
  });

  it('leaves unfilled placeholders visible rather than dropping them', () => {
    expect(PromptLibrary.render('collab.generation').user).toBe('Generate a creative response to: ${prompt}');
  });

  it('the alternative generation prompt asks for a different approach', () => {
    const { system, user } = PromptLibrary.render('collab.generation.alternative', { prompt: 'x' });
    expect(system).toContain('Take a different approach than the obvious solution.');
    expect(user).toBe('Generate an alternative creative response to: x');
  });

  it('the evaluator persona has no user template and renders an empty user prompt', () => {
    const { system, user } = PromptLibrary.render('eval.heuristic-persona');
    expect(system).toContain('Score 1-10 with brief justification.');
    expect(user).toBe('');
  });

  it('every collab user template only uses placeholders that rendering can fill', () => {
    const unfillable: string[] = [];
    for (const id of COLLAB_IDS) {
      const tpl = PromptLibrary.get(id)!.userPromptTemplate ?? '';
      const names = [...tpl.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
      const vars = Object.fromEntries(names.map(n => [n, `<${n}>`]));
      const out = PromptLibrary.render(id, vars).user;
      if (out.includes('${')) unfillable.push(id);
      for (const n of names) if (!out.includes(`<${n}>`)) unfillable.push(`${id}:${n}`);
    }
    expect(unfillable).toEqual([]);
  });
});
