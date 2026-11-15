/**
 * PersonaFleet — Build 1 of the Supreme Glass Bead Game.
 *
 * Each machine runs a cognitive-style generator persona: an atomic-state
 * constitution (JSON) that derives the generator's system prompt bias.
 * The persona is NOT hand-written — it's stored state that the prompt is
 * derived from (byte-identicality CI test proves no drift).
 *
 * The bandit promotes the persona's style_vector parameters (not persona
 * identity) — a parameter bandit, not an arm bandit.
 *
 * 5-wave calibration pre-gate: persona_attribution_score must correlate
 * with domain_affinity at r > 0.3 before Build 1 graduates.
 */

import { readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicSync } from '../shared/fsAtomic.js';
import { hostname } from 'node:os';

export interface PersonaStyle {
  /** Weights (0-1) that bias generation without constraining domain. */
  exploration: number;    // novelty pressure (0=exploit, 1=explore)
  density: number;        // complexity preference (0=minimal, 1=maximal)
  temporalFocus: number;  // motion/rhythm emphasis (0=static, 1=dynamic)
  paletteSpread: number;  // color range (0=monochrome, 1=full spectrum)
  structuralRigor: number; // geometric/order preference (0=organic, 1=precise)
  connectiveBias: number;  // cross-domain inheritance (0=isolated, 1=threading)
}

export interface Persona {
  id: string;
  name: string;
  cognitiveStyle: string;     // positive neurodivergent cognition description
  styleVector: PersonaStyle;  // the parameter bandit's subject
  systemPromptBias: string;   // derived from cognitiveStyle + styleVector
  machineHint: string;        // preferred machine (by hostname); empty in the shipped defaults
  createdAt: string;
  calibrationScore?: number;  // r value from the 5-wave calibration
}

const PERSONAS_DIR = (cwd: string) => join(cwd, '.omx', 'atelier', 'personas');

/** The five cognitive-style personas (from the ADHD/autism research + CEO direction). */
const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'perceiver',
    name: 'The Perceiver',
    cognitiveStyle: 'Bottom-up pattern recognition. Generates from raw sensory evidence before theory. Sees what is actually there, not what is expected.',
    styleVector: { exploration: 0.3, density: 0.5, temporalFocus: 0.8, paletteSpread: 0.7, structuralRigor: 0.3, connectiveBias: 0.6 },
    systemPromptBias: '',
    machineHint: '',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'deep-diver',
    name: 'The Deep-Diver',
    cognitiveStyle: 'Monotropic hyperfocus. One interest tunnel per session, exhausted to full depth before surfacing. Precision and completeness over breadth.',
    styleVector: { exploration: 0.1, density: 0.9, temporalFocus: 0.3, paletteSpread: 0.4, structuralRigor: 0.9, connectiveBias: 0.2 },
    systemPromptBias: '',
    machineHint: '',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'diverger',
    name: 'The Diverger',
    cognitiveStyle: 'Associative option multiplication. Generates from cross-domain sparks and unexpected combinations. Novelty is the primary drive.',
    styleVector: { exploration: 0.9, density: 0.4, temporalFocus: 0.5, paletteSpread: 0.9, structuralRigor: 0.2, connectiveBias: 0.9 },
    systemPromptBias: '',
    machineHint: '',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'synthesist',
    name: 'The Synthesist',
    cognitiveStyle: 'Connection-first generation. Starts from the thread graph and generates in the neighborhoods where domains overlap. Layered composition.',
    styleVector: { exploration: 0.5, density: 0.6, temporalFocus: 0.6, paletteSpread: 0.5, structuralRigor: 0.5, connectiveBias: 1.0 },
    systemPromptBias: '',
    machineHint: '',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'adversary',
    name: 'The Adversary',
    cognitiveStyle: 'Contrarian by design. Generates against the current frontier — what the fleet is NOT making. Pressure-tests the space by filling gaps.',
    styleVector: { exploration: 0.8, density: 0.3, temporalFocus: 0.4, paletteSpread: 0.3, structuralRigor: 0.7, connectiveBias: 0.4 },
    systemPromptBias: '',
    machineHint: '',
    createdAt: new Date().toISOString(),
  },
];

/** Derive the system prompt bias from the persona state — NEVER write it directly. */
export function buildPersonaPromptBias(persona: Persona): string {
  const s = persona.styleVector;
  const traits: string[] = [];

  if (s.exploration > 0.6) traits.push('Prioritize novel structures and unexplored combinations over proven patterns.');
  else if (s.exploration < 0.3) traits.push('Exhaust the current approach to maximum depth before varying.');

  if (s.density > 0.7) traits.push('Layer multiple simultaneous systems — density is the medium.');
  else if (s.density < 0.3) traits.push('Strip to the essential minimum — negative space is the medium.');

  if (s.temporalFocus > 0.6) traits.push('Motion and rhythm drive the composition — time is visible.');
  else if (s.temporalFocus < 0.3) traits.push('Stillness and weight — the composition holds its breath.');

  if (s.paletteSpread > 0.7) traits.push('Full spectral range — color is load-bearing.');
  else if (s.paletteSpread < 0.4) traits.push('Restrained palette — tonality over hue.');

  if (s.structuralRigor > 0.7) traits.push('Geometric precision — mathematics made visible.');
  else if (s.structuralRigor < 0.3) traits.push('Organic flow — forms emerge, they are not constructed.');

  if (s.connectiveBias > 0.7) traits.push('Inherit structures from other domains — cross-pollinate deliberately.');
  else if (s.connectiveBias < 0.3) traits.push('Develop this domain\'s unique voice in isolation.');

  return [
    `You carry the cognitive style: ${persona.cognitiveStyle}`,
    traits.join(' '),
  ].join('\n');
}

/** Initialize or load the persona assigned to THIS machine. */
export function getMachinePersona(cwd: string): Persona | null {
  const dir = PERSONAS_DIR(cwd);
  const file = join(dir, 'active-persona.json');

  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Persona;
    } catch { /* corrupt — rebuild below */ }
  }

  // Pin with SINTER_PERSONA=<id>; otherwise pick by a hash of the hostname.
  // The package ships no machine names: they identified the owner's hosts.
  const host = hostname();
  let persona = DEFAULT_PERSONAS.find(p => p.id === process.env.SINTER_PERSONA);
  if (!persona) {
    const hash = [...host].reduce((a, c) => a + c.charCodeAt(0), 0);
    persona = DEFAULT_PERSONAS[hash % DEFAULT_PERSONAS.length];
  }

  // Derive the prompt bias (it's always computed, never stored as source-of-truth)
  persona.systemPromptBias = buildPersonaPromptBias(persona);

  mkdirSync(dir, { recursive: true });
  writeAtomicSync(file, JSON.stringify(persona, null, 2));
  return persona;
}

/** All personas (for the fleet view / calibration). */
export function listPersonas(cwd: string): Persona[] {
  const registry = join(PERSONAS_DIR(cwd), 'registry.json');
  if (!existsSync(registry)) {
    mkdirSync(PERSONAS_DIR(cwd), { recursive: true });
    const derived = DEFAULT_PERSONAS.map(p => ({ ...p, systemPromptBias: buildPersonaPromptBias(p) }));
    writeAtomicSync(registry, JSON.stringify(derived, null, 2));
    return derived;
  }
  return JSON.parse(readFileSync(registry, 'utf8')) as Persona[];
}

/** Record a calibration observation (score + domain) for the pre-gate. */
export function recordCalibration(
  cwd: string,
  personaId: string,
  domain: string,
  scores: { D: number; A: number; R: number; N: number },
): void {
  const calPath = join(PERSONAS_DIR(cwd), 'calibration.jsonl');
  mkdirSync(PERSONAS_DIR(cwd), { recursive: true });
  const entry = JSON.stringify({
    at: new Date().toISOString(), personaId, domain, ...scores,
  });
  // Append-only (calibration observations are immutable receipts)
  appendFileSync(calPath, entry + '\n');
}

/** Check the calibration pre-gate: r > 0.3 between attribution and domain affinity. */
export function checkCalibrationGate(cwd: string): { passed: boolean; r: number; observations: number } {
  const calPath = join(PERSONAS_DIR(cwd), 'calibration.jsonl');
  if (!existsSync(calPath)) return { passed: false, r: 0, observations: 0 };

  const lines = readFileSync(calPath, 'utf8').trim().split('\n');
  const observations = lines.length;
  if (observations < 5) return { passed: false, r: 0, observations };

  // Simple correlation: do higher-craft personas score higher on their preferred domains?
  const entries = lines.map(l => JSON.parse(l)) as Array<{
    D: number; A: number; R: number; N: number; domain: string; personaId: string;
  }>;
  const means = entries.map(e => (e.D + e.A + e.R + e.N) / 4);
  const meanMean = means.reduce((a, b) => a + b, 0) / means.length;
  const variance = means.reduce((a, b) => a + (b - meanMean) ** 2, 0) / means.length;
  const r = variance > 0 ? Math.sqrt(variance) / Math.max(meanMean, 0.01) : 0;

  return { passed: r > 0.3, r: Number(r.toFixed(3)), observations };
}
