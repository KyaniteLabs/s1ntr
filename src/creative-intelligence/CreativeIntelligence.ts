import { createHash } from 'node:crypto';
import {
  MOTION_TEMPORAL_CONTRACTS,
} from './temporal/MotionTemporalContracts.js';
import { isDeepStrictEqual } from 'node:util';

import { ARTISTIC_TECHNIQUES, COLOR_THEORY, COMPOSITION, INTERACTION_A11Y } from '../brain/comprehensive-artistic-knowledge.js';

export const CREATIVE_PRINCIPLE_MANIFEST_SCHEMA = 'sinter.creative-principle-manifest' as const;
export const CREATIVE_PRINCIPLE_CONTRACT_SCHEMA = 'sinter.creative-principle-contract' as const;
export const CREATIVE_THESIS_SCHEMA = 'sinter.creative-thesis' as const;
export const CREATIVE_PRINCIPLE_MANIFEST_VERSION = 1 as const;
export const CREATIVE_PRINCIPLE_CONTRACT_VERSION = 1 as const;
export const CREATIVE_THESIS_VERSION = 1 as const;

export const COLOR_COMPOSITION_MANIFEST_SCHEMA = 'sinter.color-composition-manifest' as const;
export const COLOR_COMPOSITION_MANIFEST_VERSION = 1 as const;
export const MUSIC_SOUND_MANIFEST_SCHEMA = 'sinter.music-sound-manifest' as const;
export const MUSIC_SOUND_MANIFEST_VERSION = 1 as const;

export const INTERACTION_A11Y_MANIFEST_SCHEMA = 'sinter.interaction-a11y-manifest' as const;
export const INTERACTION_A11Y_MANIFEST_VERSION = 1 as const;

// Maximum number of bounded attribution revisions a single supported
// interaction / accessibility request may yield during a CreativeRun.
export const INTERACTION_A11Y_BOUNDED_REVISION_MAX = 1 as const;

export type ColorCompositionRowType = 'color' | 'composition';
export type ColorCompositionDisposition = 'supported' | 'unsupported';
export type MusicSoundRowDomain = 'p5' | 'three' | 'strudel' | 'tone';
export type MusicSoundDisposition = 'supported' | 'unsupported';

export interface MusicSoundSourceRow {
  readonly source: typeof MUSIC_SOUND_MANIFEST_SCHEMA;
  readonly sourceVersion: typeof MUSIC_SOUND_MANIFEST_VERSION;
  readonly domain: MusicSoundRowDomain;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly sourceDigest: string;
}

export interface MusicSoundDispositionEntry {
  readonly row: MusicSoundSourceRow;
  readonly contractId: string | null;
  readonly contractDigest: string;
  readonly sourceDigest: string;
  readonly disposition: MusicSoundDisposition;
  readonly runtimePath: string | null;
  readonly scenarioIds: readonly string[];
  readonly reason?: string;
}

export interface ColorCompositionSourceRow {
  readonly source: typeof COLOR_COMPOSITION_MANIFEST_SCHEMA;
  readonly sourceVersion: typeof COLOR_COMPOSITION_MANIFEST_VERSION;
  readonly rowType: ColorCompositionRowType;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly sourceDigest: string;
}

export interface ColorCompositionDispositionEntry {
  readonly row: ColorCompositionSourceRow;
  readonly principleId: string | null;
  readonly contractDigest: string;
  readonly sourceDigest: string;
  readonly disposition: ColorCompositionDisposition;
  readonly reason?: string;
}

export type InteractionA11yRowType = 'interaction' | 'accessibility';
export type InteractionA11yDisposition = 'supported' | 'historical' | 'unsupported';

export interface InteractionA11ySourceRow {
  readonly source: typeof INTERACTION_A11Y_MANIFEST_SCHEMA;
  readonly sourceVersion: typeof INTERACTION_A11Y_MANIFEST_VERSION;
  readonly rowType: InteractionA11yRowType;
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly sourceDigest: string;
}

export interface InteractionA11yDispositionEntry {
  readonly row: InteractionA11ySourceRow;
  readonly principleId: string | null;
  readonly contractDigest: string;
  readonly sourceDigest: string;
  readonly disposition: InteractionA11yDisposition;
  readonly reason?: string;
}

export type CreativePrincipleStatus = 'hard' | 'soft';
export type CreativeThesisDisposition = 'supported' | 'unsupported';
export type ThesisPrincipleDisposition = 'selected' | 'relevant' | 'unsupported';

export interface CreativePrincipleContract {
  readonly schema: typeof CREATIVE_PRINCIPLE_CONTRACT_SCHEMA;
  readonly schemaVersion: typeof CREATIVE_PRINCIPLE_CONTRACT_VERSION;
  readonly identity: { readonly id: string; readonly name: string; readonly aliases: readonly string[] };
  readonly domain: { readonly domain: string; readonly category: string };
  readonly theory: { readonly claim: string; readonly mechanism: string };
  readonly controllableVariables: readonly { readonly id: string; readonly label: string; readonly description: string }[];
  readonly positiveApplicability: readonly string[];
  readonly negativeApplicability: readonly string[];
  readonly prerequisites: readonly string[];
  readonly compatiblePrinciples: readonly string[];
  readonly conflictingPrinciples: readonly string[];
  readonly status: CreativePrincipleStatus;
  readonly domainAdapters: Readonly<Record<string, { readonly translation: string; readonly controls: readonly string[] }>>;
  readonly observablePerceptualEvidence: readonly { readonly id: string; readonly signal: string; readonly description: string }[];
  readonly revisionOperators: readonly { readonly id: string; readonly label: string; readonly operation: string }[];
  readonly intentionalViolationRules: readonly { readonly rule: string; readonly evidence: string }[];
  readonly provenance: { readonly sources: readonly { readonly id: string; readonly title: string; readonly locator: string }[]; readonly curator: string };
  readonly confidence: { readonly score: number; readonly rationale: string };
  readonly supersession: { readonly state: 'active' | 'superseded'; readonly supersedes?: string; readonly supersededBy?: string };
}

export interface CreativePrincipleManifest {
  readonly schema: typeof CREATIVE_PRINCIPLE_MANIFEST_SCHEMA;
  readonly schemaVersion: typeof CREATIVE_PRINCIPLE_MANIFEST_VERSION;
  readonly contracts: Readonly<Record<string, CreativePrincipleContract>>;
}

export interface CreativeThesisCitation {
  readonly principleId: string;
  readonly contractVersion: number;
  readonly sourceId: string;
  readonly locator: string;
}

export interface CreativeThesisPrinciple {
  readonly principleId: string;
  readonly disposition: ThesisPrincipleDisposition;
  readonly applicabilityReason: string;
  readonly contractIdentity: { readonly principleId: string; readonly contractVersion: number; readonly projectionDigest: string };
}

export interface CreativeThesis {
  readonly schema: typeof CREATIVE_THESIS_SCHEMA;
  readonly schemaVersion: typeof CREATIVE_THESIS_VERSION;
  readonly thesisId: string;
  readonly briefDigest: string;
  readonly disposition: CreativeThesisDisposition;
  readonly exampleFree: true;
  readonly intendedExperienceMeaning: string;
  readonly perceptualEmotionalArc: readonly string[];
  readonly principles: readonly CreativeThesisPrinciple[];
  readonly tensions: readonly string[];
  readonly uncertaintiesAssumptions: readonly string[];
  readonly nonGoals: readonly string[];
  readonly hardFloors: readonly string[];
  readonly openCreativeDimensions: readonly string[];
  readonly candidateSuccessEvidence: readonly string[];
  readonly excludedAlternatives: readonly string[];
  readonly citations: readonly CreativeThesisCitation[];
  readonly unsupported: readonly { readonly requested: string; readonly reason: string }[];
  // Optional for backward compatibility: a prior-v1 thesis persisted before
  // this field existed is migrated by `validateCreativeThesis`. A freshly
  // compiled thesis always carries the plan.
  readonly formTypography?: CreativeFormTypographyPlan;
}

export type FormTypographyDisposition = 'supported' | 'historical' | 'unsupported';

export interface FormTypographyRow {
  readonly id: string;
  readonly family: 'form' | 'typography';
  readonly label: string;
  readonly disposition: FormTypographyDisposition;
  readonly sourceLocator: string;
  readonly rationale: string;
  readonly reachability: { readonly createEntryPoints: readonly string[]; readonly generatorDomains: readonly string[] };
  readonly scenarioCoverage: readonly { readonly id: string; readonly prompt: string; readonly expectedEvidence: string }[];
  /** Non-mutating prompt instructions for the model. Read at prompt-context
   *  time only — never injected as CSS into the rendered artifact. */
  readonly rendering: { readonly instruction: string; readonly cssProperties: readonly string[] };
  /** Declared perceptual targets for this row. Source list for the plan's
   *  `declaredTargets` — these are design intents, NOT runtime measurements. */
  readonly perceptualEvidence: readonly { readonly id: string; readonly metric: string; readonly target: string }[];
  readonly boundedRevision: { readonly operator: string; readonly maxAttempts: number; readonly trigger: string };
}

export interface CreativeFormTypographyPlan {
  readonly selected: readonly { readonly rowId: string; readonly sourceLocator: string; readonly rationale: string; readonly evidenceIds: readonly string[] }[];
  readonly rationale: string;
  /** Declared per-row design targets (scale ratio, spacing, contrast, etc.).
   *  These are aspirational targets drawn from the frozen row manifest — they
   *  are NOT measured at runtime. Observed render-gate evidence is reported
   *  separately by `CompositionOrchestrator.creativeEvidence.gateEvidence`. */
  readonly declaredTargets: readonly { readonly rowId: string; readonly metric: string; readonly target: string }[];
  readonly boundedRevision: { readonly maxAttempts: 1; readonly operator: string; readonly trigger: string };
  readonly excluded: readonly { readonly rowId: string; readonly disposition: 'historical' | 'unsupported'; readonly reason: string }[];
}

export interface CreativeThesisIdentity {
  readonly thesisId: string;
  readonly principleId: string;
  readonly contractVersion: number;
  readonly projectionDigest: string;
}

export interface ProjectionDriftReport {
  readonly drift: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const CONTRAST_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'contrast', name: 'Contrast', aliases: ['juxtaposition', 'difference', 'dynamic opposition'] },
  domain: { domain: 'cross-domain', category: 'perceptual-structure' },
  theory: {
    claim: 'Perceptible difference directs attention and gives change a readable shape.',
    mechanism: 'Separate value, scale, density, motion, or timbre so neighboring signals clarify one another.',
  },
  controllableVariables: [
    { id: 'value', label: 'Value contrast', description: 'Distance between light and dark values.' },
    { id: 'scale', label: 'Scale contrast', description: 'Difference in size or spatial authority.' },
    { id: 'density', label: 'Density contrast', description: 'Difference between sparse and concentrated activity.' },
    { id: 'tempo', label: 'Temporal contrast', description: 'Difference between stillness and movement or speed.' },
  ],
  positiveApplicability: ['The brief needs a focal point, legible change, or a perceptual threshold.', 'The intended arc moves between restraint and release.'],
  negativeApplicability: ['The brief explicitly requires uniformity with no hierarchy.', 'Additional separation would overwhelm a deliberately fragile or hushed experience.'],
  prerequisites: ['At least two perceptual signals or states can be distinguished.', 'The work has a focal relationship worth making legible.'],
  compatiblePrinciples: ['rhythm', 'emphasis', 'unity'],
  conflictingPrinciples: ['uniformity', 'undifferentiated field'],
  status: 'soft',
  domainAdapters: {
    visual: { translation: 'Separate luminance, scale, color temperature, or density.', controls: ['value', 'scale', 'density'] },
    motion: { translation: 'Alternate stillness and motion so the arc reads.', controls: ['tempo', 'density'] },
    audio: { translation: 'Separate register, timbre, amplitude, or silence.', controls: ['value', 'tempo'] },
  },
  observablePerceptualEvidence: [
    { id: 'focal-separation', signal: 'focal separation', description: 'A viewer can identify the intended focal subject without searching.' },
    { id: 'arc-legibility', signal: 'arc legibility', description: 'The change from opening state to release is perceptible in sequence.' },
    { id: 'hierarchy', signal: 'hierarchy', description: 'Dominant and supporting signals do not compete at the same level.' },
  ],
  revisionOperators: [
    { id: 'increase', label: 'Increase contrast', operation: 'Move one controllable variable farther apart while preserving the focal relationship.' },
    { id: 'localize', label: 'Localize contrast', operation: 'Concentrate the difference at the focal moment or subject.' },
    { id: 'reverse', label: 'Reverse contrast', operation: 'Swap which signal is dominant while retaining perceptual separation.' },
  ],
  intentionalViolationRules: [
    { rule: 'Contrast may be withheld or collapsed when ambiguity is the declared meaning.', evidence: 'The collapse is localized, legible as a choice, and does not break the hard floors.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-principles-contrast',
      title: 'Liminal comprehensive artistic knowledge: Contrast',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#DESIGN_PRINCIPLES/Contrast',
    }],
    curator: 'sinter-wave-8',
  },
  confidence: { score: 0.86, rationale: 'The contract names controllable levers and observable evidence instead of prescribing a style.' },
  supersession: { state: 'active' },
});

const COLOR_HARMONY_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'color-harmony', name: 'Color Harmony', aliases: ['color balance', 'palette balance', 'palette equilibrium'] },
  domain: { domain: 'cross-domain', category: 'perceptual-structure' },
  theory: {
    claim: 'Coordinated color relationships give the field a coherent mood without collapsing difference.',
    mechanism: 'Choose a small set of related hues and weight them so dominant and supporting roles stay legible.',
  },
  controllableVariables: [
    { id: 'palette-size', label: 'Palette size', description: 'Number of distinct hues participating in the field.' },
    { id: 'weight', label: 'Color weight', description: 'Relative dominance of each hue by area or frequency.' },
    { id: 'temperature', label: 'Temperature bias', description: 'Bias of the palette toward warm or cool hue families.' },
  ],
  positiveApplicability: ['The brief calls for a coherent mood, a recognizable palette, or sustained atmosphere.', 'Multiple domains or layers must feel like one work.'],
  negativeApplicability: ['The brief forbids hue choice or demands a single-channel treatment.', 'Contrast alone is enough to carry the work and adding harmony would mute the difference.'],
  prerequisites: ['At least one hue must be selectable.', 'The work has a duration or surface where the palette can be observed as a whole.'],
  compatiblePrinciples: ['contrast', 'rhythm', 'focal-point'],
  conflictingPrinciples: ['monochrome wash'],
  status: 'soft',
  domainAdapters: {
    visual: { translation: 'Restrict the palette to related hues and weight them so the dominant hue reads first.', controls: ['palette-size', 'weight'] },
    motion: { translation: 'Crossfade between related hues so the palette shift feels continuous.', controls: ['temperature', 'weight'] },
    audio: { translation: 'Treat harmony as compatible timbre families that share spectral weight.', controls: ['palette-size', 'weight'] },
  },
  observablePerceptualEvidence: [
    { id: 'palette-coherence', signal: 'palette coherence', description: 'A viewer can name the palette family without seeing it named.' },
    { id: 'mood-legibility', signal: 'mood legibility', description: 'The intended mood (warm, cool, calm, energetic) is perceivable without instruction.' },
    { id: 'no-hue-clash', signal: 'no hue clash', description: 'No two unrelated hues compete for the dominant role.' },
  ],
  revisionOperators: [
    { id: 'shrink-palette', label: 'Shrink palette', operation: 'Reduce the palette to its dominant hue and one supporting hue.' },
    { id: 'reweight', label: 'Reweight palette', operation: 'Shift area or frequency so the dominant hue becomes unmistakably primary.' },
    { id: 'shift-temperature', label: 'Shift temperature', operation: 'Move every hue one step along the warm-cool axis while preserving relationships.' },
  ],
  intentionalViolationRules: [
    { rule: 'Palette harmony may be deliberately broken when the work is about dissonance or surprise.', evidence: 'The break is concentrated, declared as a choice, and does not erase the focal subject.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-color-harmony',
      title: 'Liminal comprehensive artistic knowledge: Color Harmony',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#COLOR_THEORY/Color Harmony',
    }],
    curator: 'sinter-wave-8',
  },
  confidence: { score: 0.82, rationale: 'The contract translates the recipe-named Color Harmony row into cross-domain controllable levers.' },
  supersession: { state: 'active' },
});

const FOCAL_POINT_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'focal-point', name: 'Focal Point', aliases: ['center of interest', 'primary subject', 'principal subject'] },
  domain: { domain: 'cross-domain', category: 'perceptual-structure' },
  theory: {
    claim: 'A single, legible subject directs perception and gives the work a clear primary reading.',
    mechanism: 'Concentrate difference (luminance, scale, density, motion, or timbre) at one site so supporting signals recede.',
  },
  controllableVariables: [
    { id: 'subject-isolation', label: 'Subject isolation', description: 'Distance between the subject and its surroundings in luminance, scale, density, or motion.' },
    { id: 'supporting-suppression', label: 'Supporting suppression', description: 'How much the surrounding field quiets itself to avoid competing with the subject.' },
    { id: 'entry-position', label: 'Entry position', description: 'Where on the canvas or timeline the subject first appears.' },
  ],
  positiveApplicability: ['The brief names a single subject or asks for a clear primary reading.', 'The work has a field large enough that the eye needs an anchor.'],
  negativeApplicability: ['The brief forbids hierarchy or demands an undifferentiated field.', 'The work is a pure pattern with no intended subject.'],
  prerequisites: ['A candidate subject can be identified in the brief.', 'The medium allows concentration of a signal at one site.'],
  compatiblePrinciples: ['contrast', 'negative-space', 'rhythm'],
  conflictingPrinciples: ['uniform field', 'undifferentiated pattern'],
  status: 'soft',
  domainAdapters: {
    visual: { translation: 'Place a single bright or large subject inside a quieted field; suppress competing detail.', controls: ['subject-isolation', 'supporting-suppression'] },
    motion: { translation: 'Cue one movement peak and let surrounding motion soften around it.', controls: ['subject-isolation', 'supporting-suppression'] },
    audio: { translation: 'Bring one timbre or melody to the foreground while the rest of the mix steps back.', controls: ['subject-isolation', 'supporting-suppression'] },
  },
  observablePerceptualEvidence: [
    { id: 'subject-found', signal: 'subject found', description: 'A viewer can locate the primary subject without searching.' },
    { id: 'no-competition', signal: 'no competition', description: 'No supporting signal demands equal attention with the subject.' },
    { id: 'entry-anchor', signal: 'entry anchor', description: 'The subject is one of the first things perceived.' },
  ],
  revisionOperators: [
    { id: 'isolate', label: 'Isolate', operation: 'Move one controllable variable farther between subject and field.' },
    { id: 'quiet-the-field', label: 'Quiet the field', operation: 'Suppress surrounding signals so the subject stands alone.' },
    { id: 'reposition', label: 'Reposition subject', operation: 'Move the subject to a stronger entry point on the canvas or timeline.' },
  ],
  intentionalViolationRules: [
    { rule: 'A focal point may be withheld when ambiguity is the declared meaning.', evidence: 'The absence is concentrated and legible as a single choice, not an accident.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-focal-point',
      title: 'Liminal comprehensive artistic knowledge: Focal Point',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#COMPOSITION/Focal Point',
    }],
    curator: 'sinter-wave-8',
  },
  confidence: { score: 0.85, rationale: 'The contract reframes the Focal Point row as a cross-domain controllable hierarchy, not a placement rule.' },
  supersession: { state: 'active' },
});

const NEGATIVE_SPACE_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'negative-space', name: 'Negative Space', aliases: ['breathing room', 'empty area', 'quiet field'] },
  domain: { domain: 'cross-domain', category: 'perceptual-structure' },
  theory: {
    claim: 'Deliberate emptiness gives signals room to read and lets the work breathe.',
    mechanism: 'Reserve area or duration for absence so the present signals become sharper and the work feels settled.',
  },
  controllableVariables: [
    { id: 'rest-area', label: 'Rest area', description: 'Fraction of the field or timeline held empty or near-empty.' },
    { id: 'rest-placement', label: 'Rest placement', description: 'Where the rest area sits relative to active signals.' },
    { id: 'rest-quality', label: 'Rest quality', description: 'Whether the rest is uniform, graduated, or shaped by neighboring signals.' },
  ],
  positiveApplicability: ['The brief calls for calm, restraint, breathing room, or quiet.', 'The intended arc depends on a perceivable release after activity.'],
  negativeApplicability: ['The brief forbids stillness or requires a saturated, dense field.', 'The work is short enough that rest would erase the subject.'],
  prerequisites: ['The medium supports deliberate emptiness (canvas area, silent frames, hold states).', 'At least one active signal exists to make the rest perceivable.'],
  compatiblePrinciples: ['focal-point', 'contrast', 'rhythm'],
  conflictingPrinciples: ['maximal density', 'continual activity'],
  status: 'soft',
  domainAdapters: {
    visual: { translation: 'Hold a portion of the canvas as unbroken empty space around the subject.', controls: ['rest-area', 'rest-placement'] },
    motion: { translation: 'Hold still for a perceptible interval between active passages.', controls: ['rest-area', 'rest-quality'] },
    audio: { translation: 'Reserve a duration of silence or near-silence to set off sounding passages.', controls: ['rest-area', 'rest-quality'] },
  },
  observablePerceptualEvidence: [
    { id: 'breath', signal: 'breath', description: 'A viewer perceives the work as having room to breathe.' },
    { id: 'release', signal: 'release', description: 'A shift from active to rest is perceivable as a release.' },
    { id: 'no-clutter', signal: 'no clutter', description: 'No portion of the field competes for equal weight.' },
  ],
  revisionOperators: [
    { id: 'expand-rest', label: 'Expand rest', operation: 'Enlarge the rest area or lengthen the rest duration.' },
    { id: 'shape-rest', label: 'Shape rest', operation: 'Make the rest area a deliberate shape instead of a uniform block.' },
    { id: 'shorten-rest', label: 'Shorten rest', operation: 'Reduce rest when the work feels stalled.' },
  ],
  intentionalViolationRules: [
    { rule: 'Negative space may be withheld when the work requires maximum density or continual activity.', evidence: 'The density is uniform and intentional, not an accidental loss of room.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-negative-space',
      title: 'Liminal comprehensive artistic knowledge: Negative Space',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#COMPOSITION/Negative Space',
    }],
    curator: 'sinter-wave-8',
  },
  confidence: { score: 0.84, rationale: 'The contract names rest area, placement, and quality as cross-domain levers instead of a placement rule.' },
  supersession: { state: 'active' },
});

const RHYTHM_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'rhythm', name: 'Rhythm', aliases: ['beat', 'alternation', 'pulse', 'temporal pattern'] },
  domain: { domain: 'cross-domain', category: 'perceptual-structure' },
  theory: {
    claim: 'A perceivable alternation between signal and rest gives a work temporal shape.',
    mechanism: 'Repeat a recognizable unit with a chosen interval and a chosen variation so the alternation reads as motion.',
  },
  controllableVariables: [
    { id: 'interval', label: 'Interval', description: 'Time or distance between repeating units.' },
    { id: 'variation', label: 'Variation', description: 'How much each repetition changes from the previous one.' },
    { id: 'accent', label: 'Accent', description: 'Which unit in the pattern is emphasized.' },
  ],
  positiveApplicability: ['The brief asks for a beat, pulse, or temporal pattern.', 'The work unfolds over time or across a sequence of frames.'],
  negativeApplicability: ['The brief forbids repetition or demands a single, undivided moment.', 'The work is too short to register a pattern.'],
  prerequisites: ['At least one repeating unit can be defined.', 'The medium preserves time so the alternation is perceivable.'],
  compatiblePrinciples: ['contrast', 'focal-point', 'color-harmony'],
  conflictingPrinciples: ['single still moment'],
  status: 'soft',
  domainAdapters: {
    motion: { translation: 'Alternate activity and rest at a chosen interval; vary one element across repetitions.', controls: ['interval', 'variation'] },
    audio: { translation: 'Define a beat, vary one parameter across repetitions, and accent one beat per measure.', controls: ['interval', 'accent'] },
    visual: { translation: 'Repeat a unit across frames with a chosen interval and a single accent frame.', controls: ['interval', 'variation'] },
  },
  observablePerceptualEvidence: [
    { id: 'pulse-found', signal: 'pulse found', description: 'A viewer perceives the beat or alternation without instruction.' },
    { id: 'variation-legible', signal: 'variation legible', description: 'A change across repetitions is perceivable but does not erase the pattern.' },
    { id: 'accent-clear', signal: 'accent clear', description: 'One unit is unmistakably emphasized.' },
  ],
  revisionOperators: [
    { id: 'tighten-interval', label: 'Tighten interval', operation: 'Shorten the interval between repetitions to increase urgency.' },
    { id: 'introduce-variation', label: 'Introduce variation', operation: 'Change one parameter across repetitions so the pattern evolves.' },
    { id: 'shift-accent', label: 'Shift accent', operation: 'Move the emphasis to a different unit in the pattern.' },
  ],
  intentionalViolationRules: [
    { rule: 'Rhythm may be deliberately broken when the work calls for an irregular, unrepeated event.', evidence: 'The break is concentrated and labeled by the work as a choice.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-rhythm',
      title: 'Liminal comprehensive artistic knowledge: Rhythm',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#DESIGN_PRINCIPLES/Rhythm',
    }],
    curator: 'sinter-wave-8',
  },
  confidence: { score: 0.83, rationale: 'The contract makes rhythm a cross-domain alternation lever rather than a visual repetition rule.' },
  supersession: { state: 'active' },
});

const KEYBOARD_OPERATION_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'keyboard-operation', name: 'Keyboard Operation', aliases: ['keyboard reachable', 'keyboard control', 'operable via keyboard'] },
  domain: { domain: 'cross-domain', category: 'interaction-structure' },
  theory: {
    claim: 'Every interactive control is reachable and operable without a pointer, so the work remains useful to keyboard-only users.',
    mechanism: 'Expose each interactive control as a native focusable element so it lands in the document tab sequence and responds to activation keys (Enter, Space, arrow keys).',
  },
  controllableVariables: [
    { id: 'focusable-role', label: 'Focusable role', description: 'Use a focusable element or role (button, link, input, tab, switch) for every interactive control.' },
    { id: 'activation-key', label: 'Activation key', description: 'Native or explicit handling of Enter / Space / arrow activation for the chosen role.' },
    { id: 'no-pointer-trap', label: 'No pointer trap', description: 'Avoid custom handlers that swallow keystrokes or strand focus on a hidden control.' },
  ],
  positiveApplicability: ['The work exposes interactive controls that must be usable without a pointer.', 'The intended audience includes keyboard-only or assistive-technology users.'],
  negativeApplicability: ['The work is a pure visual or audio piece with no interactive controls.', 'The brief explicitly forbids any user input.'],
  prerequisites: ['At least one interactive control exists in the rendered artifact.', 'Activation can be expressed through a standard keyboard event.'],
  compatiblePrinciples: ['focus-visibility', 'focus-order', 'semantic-naming', 'semantic-state', 'reduced-motion'],
  conflictingPrinciples: ['mouse-only interaction'],
  status: 'hard',
  domainAdapters: {
    visual: { translation: 'Render every interactive control as a button or link with a real focusable element; do not emulate activation on a generic div.', controls: ['focusable-role', 'activation-key'] },
    motion: { translation: 'Keep the timeline scrubbable via arrow keys and Space; pause/play on Space; never strand a transport control.', controls: ['activation-key', 'no-pointer-trap'] },
    audio: { translation: 'Make transport, scrub, and mute controls focusable so the keyboard can drive playback without sound desync.', controls: ['focusable-role', 'activation-key'] },
  },
  observablePerceptualEvidence: [
    { id: 'tab-reach', signal: 'tab reach', description: 'Every interactive control is reachable by pressing Tab from the document start.' },
    { id: 'no-trap', signal: 'no trap', description: 'No control strands focus or swallows keystrokes outside its expected behavior.' },
    { id: 'activation-on-key', signal: 'activation on key', description: 'Pressing Enter or Space on a focused control produces the same effect as its primary activation.' },
  ],
  revisionOperators: [
    { id: 'promote-button', label: 'Promote to button', operation: 'Replace any custom-click div with a real button or link so it enters the keyboard tab sequence.' },
    { id: 'add-handler', label: 'Add key handler', operation: 'Bind Enter and Space to the same handler as the activation event so keyboard users land on the same result.' },
    { id: 'escape-blur', label: 'Escape focus', operation: 'Allow Escape to release focus when the control traps it on activation.' },
  ],
  intentionalViolationRules: [
    { rule: 'Keyboard operation may be deliberately disabled only when the work has no interactive controls.', evidence: 'The artifact exposes no controls and the brief forbids user input.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-keyboard-operation',
      title: 'Liminal comprehensive artistic knowledge: Keyboard Operation',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#INTERACTION_A11Y/Keyboard Operation',
    }],
    curator: 'sinter-wave-8-w8-09',
  },
  confidence: { score: 0.92, rationale: 'Keyboard operation is a WCAG-enforceable interaction floor; the contract names native element, activation key, and pointer-trap checks.' },
  supersession: { state: 'active' },
});

const FOCUS_VISIBILITY_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'focus-visibility', name: 'Focus Visibility', aliases: ['visible focus', 'focus indicator', 'focus outline'] },
  domain: { domain: 'cross-domain', category: 'interaction-structure' },
  theory: {
    claim: 'The focused control must be unmistakably visible so the keyboard user can always locate their position.',
    mechanism: 'Render a focus indicator with at least a 3:1 contrast ratio against the adjacent surface, applied to every focusable element without exception.',
  },
  controllableVariables: [
    { id: 'outline-contrast', label: 'Outline contrast', description: 'Contrast ratio between the focus ring and the surrounding surface, target at least 3:1.' },
    { id: 'outline-thickness', label: 'Outline thickness', description: 'Thickness of the focus ring relative to the control border.' },
    { id: 'always-visible', label: 'Always visible', description: 'Focus indicator remains visible regardless of mouse focus or programmatic call.' },
  ],
  positiveApplicability: ['The work has keyboard-reachable controls.', 'The audience must always know which control is active.'],
  negativeApplicability: ['The work has no interactive controls.'],
  prerequisites: ['At least one focusable element exists.', 'The render medium supports style-based outlines.'],
  compatiblePrinciples: ['keyboard-operation', 'semantic-naming'],
  conflictingPrinciples: ['hidden focus indicator'],
  status: 'hard',
  domainAdapters: {
    visual: { translation: 'Apply a focus style on every focusable element with at least 3:1 contrast against adjacent content.', controls: ['outline-contrast', 'outline-thickness', 'always-visible'] },
    motion: { translation: 'Focus the transport control with the same outline rule so scrub position is visible while a scrub is in progress.', controls: ['outline-thickness', 'always-visible'] },
    audio: { translation: 'Keep the focused transport outlined even when audio is paused; do not collapse focus during stillness.', controls: ['always-visible'] },
  },
  observablePerceptualEvidence: [
    { id: 'ring-visible', signal: 'ring visible', description: 'A focused control shows a focus ring that contrasts against the surface beneath it.' },
    { id: 'persistent', signal: 'persistent', description: 'The focus ring remains visible while the user moves through the tab sequence.' },
    { id: 'target-contrast', signal: 'target contrast', description: 'The ring reaches at least a 3:1 contrast against its adjacent surface.' },
  ],
  revisionOperators: [
    { id: 'thicken-ring', label: 'Thicken ring', operation: 'Increase the ring thickness until it reaches at least 3:1 contrast against the surface.' },
    { id: 'lock-visibility', label: 'Lock visibility', operation: 'Remove any rule that hides the focus ring on mouse focus or programmatic events.' },
    { id: 'shift-color', label: 'Shift color', operation: 'Pick a ring color that reaches the contrast target on the chosen surface, regardless of theme.' },
  ],
  intentionalViolationRules: [
    { rule: 'Focus visibility may be collapsed only when the work has no focusable elements.', evidence: 'No focusable element exists in the rendered artifact.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-focus-visibility',
      title: 'Liminal comprehensive artistic knowledge: Focus Visibility',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#INTERACTION_A11Y/Focus Visibility',
    }],
    curator: 'sinter-wave-8-w8-09',
  },
  confidence: { score: 0.92, rationale: 'Focus visibility is a WCAG-enforceable floor with a measurable 3:1 contrast target.' },
  supersession: { state: 'active' },
});

const FOCUS_ORDER_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'focus-order', name: 'Focus Order', aliases: ['tab order', 'reading order', 'logical order'] },
  domain: { domain: 'cross-domain', category: 'interaction-structure' },
  theory: {
    claim: 'Tab order must match the document order and the intended reading order so users traverse the work predictably.',
    mechanism: 'Keep the DOM order aligned with visual order and avoid positive tabindex values that jump the natural sequence.',
  },
  controllableVariables: [
    { id: 'dom-order', label: 'DOM order', description: 'Interactive controls appear in the rendered DOM in their intended reading order.' },
    { id: 'no-tabindex-trick', label: 'No tabindex trick', description: 'Avoid positive tabindex values that reorder focus out of visual sequence.' },
    { id: 'skip-pattern', label: 'Skip pattern', description: 'Group repeated content under a skip link or landmark so the user can bypass it.' },
  ],
  positiveApplicability: ['The work exposes more than one interactive control.', 'The audience reads the work in a sequence.' ],
  negativeApplicability: ['The work exposes a single interactive control.', 'The visual order is intentionally unrelated to interaction order.'],
  prerequisites: ['At least two focusable elements exist.'],
  compatiblePrinciples: ['keyboard-operation', 'semantic-naming', 'semantic-state'],
  conflictingPrinciples: ['decorative reorder'],
  status: 'hard',
  domainAdapters: {
    visual: { translation: 'Place interactive controls in DOM order matching the visual order; never reorder them with positive tabindex.', controls: ['dom-order', 'no-tabindex-trick'] },
    motion: { translation: 'Keep scrub controls in DOM order; do not surface an isolated override control outside the natural sequence.', controls: ['dom-order'] },
    audio: { translation: 'Keep mute / scrub / play in DOM order; do not reorder them with positive tabindex.', controls: ['dom-order', 'no-tabindex-trick'] },
  },
  observablePerceptualEvidence: [
    { id: 'order-matches-reading', signal: 'order matches reading', description: 'Tabbing through controls reaches them in the same order the page reads.' },
    { id: 'no-jump', signal: 'no jump', description: 'No focus jumps out of visual sequence because of a positive tabindex trick.' },
  ],
  revisionOperators: [
    { id: 'reorder-dom', label: 'Reorder DOM', operation: 'Move controls in the source so DOM order matches visual order.' },
    { id: 'strip-positive-tabindex', label: 'Strip positive tabindex', operation: 'Remove positive tabindex so the natural sequence takes over.' },
    { id: 'add-skip-link', label: 'Add skip link', operation: 'Add a skip-to-content link when repeated controls would otherwise crowd the tab sequence.' },
  ],
  intentionalViolationRules: [
    { rule: 'Focus order may diverge from reading order only for an explicit grouping labeled by a heading or landmark.', evidence: 'A grouped landmark or heading explains the new section before any control inside it.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-focus-order',
      title: 'Liminal comprehensive artistic knowledge: Focus Order',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#INTERACTION_A11Y/Focus Order',
    }],
    curator: 'sinter-wave-8-w8-09',
  },
  confidence: { score: 0.88, rationale: 'The contract names DOM order, tabindex discipline, and skip-link grouping as cross-domain levers.' },
  supersession: { state: 'active' },
});

const SEMANTIC_NAMING_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'semantic-naming', name: 'Semantic Naming', aliases: ['accessible name', 'aria-label', 'labelled control'] },
  domain: { domain: 'cross-domain', category: 'interaction-structure' },
  theory: {
    claim: 'Every interactive control must announce its purpose so assistive technology users understand what the control does.',
    mechanism: 'Expose an accessible name via native text (button label or label association), aria-label, or aria-labelledby.',
  },
  controllableVariables: [
    { id: 'accessible-name', label: 'Accessible name', description: 'Each control carries an accessible name in the accessibility tree.' },
    { id: 'label-disambiguation', label: 'Label disambiguation', description: 'Names that repeat must carry a label that distinguishes them (for example, "Color selection — primary").' },
    { id: 'no-empty-label', label: 'No empty label', description: 'No interactive control ships without an accessible name.' },
  ],
  positiveApplicability: ['The work exposes interactive controls.', 'The audience uses assistive technology to interact.'],
  negativeApplicability: ['The work has no interactive controls.'],
  prerequisites: ['At least one interactive control exists.'],
  compatiblePrinciples: ['keyboard-operation', 'semantic-state'],
  conflictingPrinciples: ['decorative control'],
  status: 'hard',
  domainAdapters: {
    visual: { translation: 'Pair every control with a visible text label or aria-label so the accessibility tree carries the name.', controls: ['accessible-name', 'no-empty-label'] },
    motion: { translation: 'Make scrub controls announce themselves (for example, "Speed scrub").', controls: ['accessible-name', 'label-disambiguation'] },
    audio: { translation: 'Mute, scrub, and play each carry a name that announces itself in the accessibility tree.', controls: ['accessible-name', 'no-empty-label'] },
  },
  observablePerceptualEvidence: [
    { id: 'name-present', signal: 'name present', description: 'Every interactive control exposes a non-empty accessible name.' },
    { id: 'name-distinct', signal: 'name distinct', description: 'Names that repeat carry a label that distinguishes each control.' },
  ],
  revisionOperators: [
    { id: 'add-label', label: 'Add label', operation: 'Pair the control with a visible or programmatic name via label, aria-label, or aria-labelledby.' },
    { id: 'disambiguate', label: 'Disambiguate', operation: 'Differentiate control names that repeat so each announces itself.' },
    { id: 'promote-text', label: 'Promote text to label', operation: 'Use visible text as the label instead of an icon-only alt string.' },
  ],
  intentionalViolationRules: [
    { rule: 'A control may ship without an accessible name only when it is genuinely decorative (no role, no focus, no activation).', evidence: 'The control is marked aria-hidden and is not focusable.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-semantic-naming',
      title: 'Liminal comprehensive artistic knowledge: Semantic Naming',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#INTERACTION_A11Y/Semantic Naming',
    }],
    curator: 'sinter-wave-8-w8-09',
  },
  confidence: { score: 0.9, rationale: 'The contract names label sources and disambiguation rules so the accessibility tree stays complete.' },
  supersession: { state: 'active' },
});

const SEMANTIC_STATE_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'semantic-state', name: 'Semantic State', aliases: ['aria-pressed', 'aria-expanded', 'aria-selected', 'aria-disabled'] },
  domain: { domain: 'cross-domain', category: 'interaction-structure' },
  theory: {
    claim: 'Control state must be exposed semantically so assistive technology announces every change in state.',
    mechanism: 'Map each interactive state to the matching ARIA state (aria-pressed, aria-expanded, aria-selected, aria-disabled) and update it in lockstep with the visual state.',
  },
  controllableVariables: [
    { id: 'aria-pressed', label: 'aria-pressed', description: 'Toggle buttons reflect pressed state via aria-pressed.' },
    { id: 'aria-expanded', label: 'aria-expanded', description: 'Disclosure controls reflect open state via aria-expanded.' },
    { id: 'aria-selected', label: 'aria-selected', description: 'Selection controls reflect selection via aria-selected or role="option".' },
    { id: 'aria-disabled', label: 'aria-disabled', description: 'Disabled controls remain in the tab sequence but announce as disabled via aria-disabled.' },
  ],
  positiveApplicability: ['The work has toggle, disclosure, or selection controls.', 'State changes must be perceivable beyond the visual layer.'],
  negativeApplicability: ['The work has no toggle or selection controls.'],
  prerequisites: ['At least one control changes state in response to user input.'],
  compatiblePrinciples: ['keyboard-operation', 'semantic-naming'],
  conflictingPrinciples: ['visual-only state'],
  status: 'hard',
  domainAdapters: {
    visual: { translation: 'Pair every toggle or disclosure with the matching ARIA state and update it on activation.', controls: ['aria-pressed', 'aria-expanded', 'aria-selected'] },
    motion: { translation: 'Pair transport toggles (pause, loop, mute) with aria-pressed.', controls: ['aria-pressed', 'aria-disabled'] },
    audio: { translation: 'Pair mute with aria-pressed and disabled-state controls with aria-disabled.', controls: ['aria-pressed', 'aria-disabled'] },
  },
  observablePerceptualEvidence: [
    { id: 'state-sync', signal: 'state sync', description: 'Visual state and ARIA state always agree at the moment of activation.' },
    { id: 'state-announced', signal: 'state announced', description: 'A state change is announced in the accessibility tree (aria-live or focused control).' },
  ],
  revisionOperators: [
    { id: 'add-aria-state', label: 'Add ARIA state', operation: 'Bind the matching ARIA state to the control and toggle it on activation.' },
    { id: 'lock-aria-disabled', label: 'Lock aria-disabled', operation: 'Switch disabled attributes to aria-disabled so assistive technology announces the state.' },
    { id: 'live-region', label: 'Add live region', operation: 'Wrap state-changing controls with an aria-live region so assistive technology reads the new state.' },
  ],
  intentionalViolationRules: [
    { rule: 'State may be entirely visual only when the control is genuinely decorative and carries no role in the interaction.', evidence: 'The control has no role in the accessibility tree.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-semantic-state',
      title: 'Liminal comprehensive artistic knowledge: Semantic State',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#INTERACTION_A11Y/Semantic State',
    }],
    curator: 'sinter-wave-8-w8-09',
  },
  confidence: { score: 0.88, rationale: 'The contract maps each interactive state to a specific ARIA property and locks visual + ARIA in sync.' },
  supersession: { state: 'active' },
});

const REDUCED_MOTION_CONTRACT: CreativePrincipleContract = deepFreeze({
  schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
  identity: { id: 'reduced-motion', name: 'Reduced Motion', aliases: ['prefers-reduced-motion', 'vestibular safe', 'calmer motion'] },
  domain: { domain: 'cross-domain', category: 'accessibility-structure' },
  theory: {
    claim: 'Non-essential animation must respect the audience request for reduced motion so the work stays safe for vestibular-sensitive viewers.',
    mechanism: 'Detect prefers-reduced-motion and substitute a calmer, non-vestibular variant (shorter durations, removed parallax, no continuous motion).',
  },
  controllableVariables: [
    { id: 'prefers-query', label: 'prefers-reduced-motion query', description: 'Detect prefers-reduced-motion via media query and the equivalent accessibility setting.' },
    { id: 'duration-cap', label: 'Duration cap', description: 'Cap reduced-motion variants at a non-vestibular duration (target under 0.5s for non-essential transitions).' },
    { id: 'parallax-removal', label: 'Parallax removal', description: 'Disable continuous parallax or full-screen motion under reduced-motion.' },
    { id: 'substitute', label: 'Substitute presentation', description: 'Provide a calmer substitute (opacity fade or no motion) for the essential meaning of the change.' },
  ],
  positiveApplicability: ['The work contains non-essential animation, parallax, or continuous motion.', 'A vestibular-sensitive audience is in scope.'],
  negativeApplicability: ['The work is intentionally motionless.'],
  prerequisites: ['The render medium supports media queries or an equivalent accessibility setting.'],
  compatiblePrinciples: ['contrast', 'rhythm', 'focal-point', 'semantic-state'],
  conflictingPrinciples: ['continuous parallel motion', 'forced full-screen motion'],
  status: 'hard',
  domainAdapters: {
    motion: { translation: 'Cap scrub and transient transitions under 0.5s under reduced-motion; remove parallax and continuous motion.', controls: ['prefers-query', 'duration-cap', 'parallax-removal'] },
    visual: { translation: 'Swap parallax-heavy transitions for opacity fades under reduced-motion.', controls: ['prefers-query', 'substitute'] },
    audio: { translation: 'Disable flashing or rapid envelope changes under reduced-motion (vestibular safety).', controls: ['prefers-query', 'substitute'] },
  },
  observablePerceptualEvidence: [
    { id: 'reduced-detected', signal: 'reduced detected', description: 'The artifact detects prefers-reduced-motion and applies the calmer variant.' },
    { id: 'no-parallax', signal: 'no parallax', description: 'No continuous parallax or full-screen motion runs under reduced-motion.' },
    { id: 'duration-cap-honored', signal: 'duration cap honored', description: 'Reduced-motion transitions stay under the safe duration cap.' },
  ],
  revisionOperators: [
    { id: 'add-query', label: 'Add media query', operation: 'Detect prefers-reduced-motion and apply the calmer variant when it matches.' },
    { id: 'cap-duration', label: 'Cap duration', operation: 'Reduce non-essential transition durations under the safe cap.' },
    { id: 'remove-parallax', label: 'Remove parallax', operation: 'Disable continuous parallax or full-screen motion under reduced-motion.' },
  ],
  intentionalViolationRules: [
    { rule: 'Reduced motion may be ignored only for an explicit user request or for a brief flash used to convey essential state.', evidence: 'The intentional violation is documented and remains below the safe flash threshold.' },
  ],
  provenance: {
    sources: [{
      id: 'liminal-design-knowledge-reduced-motion',
      title: 'Liminal comprehensive artistic knowledge: Reduced Motion',
      locator: 'src/brain/comprehensive-artistic-knowledge.ts#INTERACTION_A11Y/Reduced Motion',
    }],
    curator: 'sinter-wave-8-w8-09',
  },
  confidence: { score: 0.9, rationale: 'Reduced motion is a WCAG-enforceable safety floor with measurable duration and parallax targets.' },
  supersession: { state: 'active' },
});

type MusicContractSeed = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly claim: string;
  readonly mechanism: string;
  readonly variables: readonly { id: string; label: string; description: string }[];
  readonly evidence: readonly { id: string; signal: string; description: string }[];
  readonly operators: readonly { id: string; label: string; operation: string }[];
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceLocator: string;
};

function musicContract(seed: MusicContractSeed): CreativePrincipleContract {
  return deepFreeze({
    schema: CREATIVE_PRINCIPLE_CONTRACT_SCHEMA, schemaVersion: CREATIVE_PRINCIPLE_CONTRACT_VERSION,
    identity: { id: seed.id, name: seed.name, aliases: seed.aliases },
    domain: { domain: 'music', category: 'sound-artifact' },
    theory: { claim: seed.claim, mechanism: seed.mechanism },
    controllableVariables: seed.variables,
    positiveApplicability: ['The brief asks for playable music or sound with this dimension.', 'The artifact can preserve time and make this dimension perceivable.'],
    negativeApplicability: ['The brief is visual-only or explicitly requests an unsupported sound technique.', 'The requested dimension cannot be measured or reproduced by the deterministic runtime.'],
    prerequisites: ['A deterministic audio artifact can be rendered.', 'The generated artifact records its exact runtime and sample schedule.'],
    compatiblePrinciples: ['music-rhythm', 'music-harmony', 'music-dynamics', 'music-timbre'].filter((id) => id !== seed.id),
    conflictingPrinciples: ['static-template', 'unmeasured-claim'], status: 'hard',
    domainAdapters: { audio: { translation: seed.mechanism, controls: seed.variables.map((item) => item.id) } },
    observablePerceptualEvidence: seed.evidence, revisionOperators: seed.operators,
    intentionalViolationRules: [{ rule: 'A musical target may be intentionally violated only when the evidence records the deviation.', evidence: 'The deviation is attributable to the exact artifact and is not presented as an observed success.' }],
    provenance: { sources: [{ id: seed.sourceId, title: seed.sourceTitle, locator: seed.sourceLocator }], curator: 'sinter-wave-8' },
    confidence: { score: 0.9, rationale: 'The contract is bounded to deterministic controls and evidence that the runtime can actually measure.' },
    supersession: { state: 'active' },
  });
}

const MUSIC_RHYTHM_CONTRACT = musicContract({
  id: 'music-rhythm', name: 'Music Rhythm', aliases: ['audio rhythm', 'musical pulse', 'groove'],
  claim: 'A repeatable onset pattern gives sound a legible temporal shape.',
  mechanism: 'Distribute deterministic onsets across a beat grid, then preserve the sample clock in evidence.',
  variables: [{ id: 'bpm', label: 'Tempo', description: 'Beats per minute on the audio clock.' }, { id: 'onset-pattern', label: 'Onset pattern', description: 'Deterministic pulse and rest positions.' }],
  evidence: [{ id: 'onset-count', signal: 'onset count', description: 'Measured transient windows occur at the declared beat-grid schedule.' }],
  operators: [{ id: 'tighten-grid', label: 'Tighten grid', operation: 'Increase the declared tempo while preserving the exact capture schedule.' }],
  sourceId: 'liminal-music-rhythm-contract', sourceTitle: 'Liminal music rhythm contract', sourceLocator: 'src/music/EuclideanRhythm.ts#generateEuclideanPattern',
});

const MUSIC_HARMONY_CONTRACT = musicContract({
  id: 'music-harmony', name: 'Music Harmony', aliases: ['audio harmony', 'chord movement', 'tonal harmony'],
  claim: 'A scale-constrained progression makes simultaneous tones read as a coherent musical field.',
  mechanism: 'Generate diatonic chords and melody notes from one key, scale, and named progression.',
  variables: [{ id: 'key', label: 'Key', description: 'Root pitch used for the scale and progression.' }, { id: 'scale', label: 'Scale', description: 'Allowed pitch collection for melodic material.' }, { id: 'progression', label: 'Progression', description: 'Ordered harmonic movement between chords.' }],
  evidence: [{ id: 'pitch-content', signal: 'pitch content', description: 'Measured spectral content is produced by the declared harmonic render.' }],
  operators: [{ id: 'simplify-voicing', label: 'Simplify voicing', operation: 'Reduce simultaneous chord tones while preserving the declared progression.' }],
  sourceId: 'liminal-music-harmony-contract', sourceTitle: 'Liminal music harmony contract', sourceLocator: 'src/music/TheoryEngine.ts#generateProgression',
});

const MUSIC_DYNAMICS_CONTRACT = musicContract({
  id: 'music-dynamics', name: 'Music Dynamics', aliases: ['audio dynamics', 'amplitude contour', 'expressive volume'],
  claim: 'A changing amplitude envelope gives a playable artifact expressive movement instead of a static level.',
  mechanism: 'Apply deterministic attack, release, and accent gains to scheduled notes and measure the resulting envelope.',
  variables: [{ id: 'envelope', label: 'Envelope', description: 'Attack, sustain, and release shape for each event.' }, { id: 'accent', label: 'Accent', description: 'Declared velocity difference between primary and supporting events.' }],
  evidence: [{ id: 'dynamic-range', signal: 'dynamic range', description: 'Measured RMS windows show a non-zero amplitude range.' }],
  operators: [{ id: 'increase-accent', label: 'Increase accent', operation: 'Increase the primary-event gain after observing insufficient measured dynamic range.' }],
  sourceId: 'liminal-music-dynamics-contract', sourceTitle: 'Liminal music dynamics contract', sourceLocator: 'src/music/MusicSoundArtifact.ts#measureAudio',
});

const MUSIC_TIMBRE_CONTRACT = musicContract({
  id: 'music-timbre', name: 'Music Timbre', aliases: ['audio timbre', 'tone color', 'spectral texture'],
  claim: 'A shaped harmonic spectrum gives a sound its identifiable tone color.',
  mechanism: 'Use a deterministic additive voice with distinct harmonic weights and a reproducible waveform identity.',
  variables: [{ id: 'waveform', label: 'Waveform', description: 'The deterministic synthesis family used by the voice.' }, { id: 'harmonics', label: 'Harmonics', description: 'Relative partials that shape spectral texture.' }],
  evidence: [{ id: 'spectral-centroid', signal: 'spectral centroid', description: 'Measured spectral centroid records the rendered frequency distribution without naming an unmeasured timbre judgment.' }],
  operators: [{ id: 'brighten-spectrum', label: 'Brighten spectrum', operation: 'Increase a declared upper partial after observing an insufficient measured spectral centroid.' }],
  sourceId: 'liminal-music-timbre-contract', sourceTitle: 'Liminal music timbre contract', sourceLocator: 'src/music/MusicSoundArtifact.ts#renderSamples',
});

export const CREATIVE_PRINCIPLE_MANIFEST: CreativePrincipleManifest = deepFreeze({
  schema: CREATIVE_PRINCIPLE_MANIFEST_SCHEMA,
  schemaVersion: CREATIVE_PRINCIPLE_MANIFEST_VERSION,
  contracts: {
    contrast: CONTRAST_CONTRACT,
    'color-harmony': COLOR_HARMONY_CONTRACT,
    'focal-point': FOCAL_POINT_CONTRACT,
    'negative-space': NEGATIVE_SPACE_CONTRACT,
    rhythm: RHYTHM_CONTRACT,
    'keyboard-operation': KEYBOARD_OPERATION_CONTRACT,
    'focus-visibility': FOCUS_VISIBILITY_CONTRACT,
    'focus-order': FOCUS_ORDER_CONTRACT,
    'semantic-naming': SEMANTIC_NAMING_CONTRACT,
    'semantic-state': SEMANTIC_STATE_CONTRACT,
    'reduced-motion': REDUCED_MOTION_CONTRACT,
    'music-rhythm': MUSIC_RHYTHM_CONTRACT,
    'music-harmony': MUSIC_HARMONY_CONTRACT,
    'music-dynamics': MUSIC_DYNAMICS_CONTRACT,
    'music-timbre': MUSIC_TIMBRE_CONTRACT,
  },
});

const FORM_TYPOGRAPHY_SOURCE = 'src/brain/comprehensive-artistic-knowledge.ts';
type FormTypographyRowSeed = Pick<FormTypographyRow, 'id' | 'family' | 'label' | 'disposition' | 'sourceLocator' | 'rationale'> & {
  readonly renderingInstruction: string;
  readonly cssProperties: readonly string[];
  readonly evidence: { readonly metric: string; readonly target: string };
};
function formTypographyRow(seed: FormTypographyRowSeed): FormTypographyRow {
  const supported = seed.disposition === 'supported';
  const { renderingInstruction, cssProperties, evidence, ...identity } = seed;
  return deepFreeze({
    ...identity,
    reachability: supported ? { createEntryPoints: ['CreativeRunCoordinator.compose', 'CompositionOrchestrator.compose'], generatorDomains: ['html', 'p5', 'kinetic'] } : { createEntryPoints: [], generatorDomains: [] },
    scenarioCoverage: supported ? [{ id: `${seed.id}-scenario`, prompt: `${seed.label} in an ordinary-language creative brief`, expectedEvidence: 'selected rationale reaches the rendered artifact' }] : [],
    rendering: { instruction: supported ? renderingInstruction : 'Never apply this row at runtime.', cssProperties: supported ? cssProperties : [] },
    perceptualEvidence: supported ? [{ id: `${seed.id}-evidence`, ...evidence }] : [],
    boundedRevision: { operator: supported ? 'one render-gate revision' : 'none', maxAttempts: supported ? 1 : 0, trigger: supported ? 'measured perceptual evidence misses its target' : 'not executable', },
  });
}

export const FORM_TYPOGRAPHY_ROWS: readonly FormTypographyRow[] = deepFreeze([
  formTypographyRow({ id: 'form-visual-hierarchy', family: 'form', label: 'Visual hierarchy', disposition: 'supported', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#COMPOSITION/Visual Hierarchy`, rationale: 'A focal relationship gives the viewer a readable order of attention.', renderingInstruction: 'Give the focal text the strongest scale and semantic weight, then preserve supporting text.', cssProperties: ['font-size', 'font-weight', 'text-wrap'], evidence: { metric: 'focal-to-supporting scale ratio', target: 'primary text is at least 1.5x supporting text' } }),
  formTypographyRow({ id: 'typography-hierarchy', family: 'typography', label: 'Typography hierarchy', disposition: 'supported', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#ARTISTIC_TECHNIQUES.p5/Typography`, rationale: 'Size, weight, and line structure make text readable as a visual material.', renderingInstruction: 'Use size, weight, and line structure to make the text hierarchy legible without naming a style.', cssProperties: ['font-size', 'font-weight', 'line-height'], evidence: { metric: 'heading-to-body scale ratio', target: 'heading text is at least 1.5x body text' } }),
  formTypographyRow({ id: 'typography-spacing', family: 'typography', label: 'Typography spacing', disposition: 'supported', sourceLocator: 'src/brain/SymbolicCreativeLanguage.ts#domainKeywords.typography', rationale: 'Spacing and leading preserve legibility while allowing expressive density.', renderingInstruction: 'Tune tracking and leading to preserve legibility at the chosen density.', cssProperties: ['letter-spacing', 'line-height'], evidence: { metric: 'body line spacing', target: 'line-height remains between 1.25 and 1.6' } }),
  formTypographyRow({ id: 'form-negative-space', family: 'form', label: 'Negative space', disposition: 'supported', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#COMPOSITION/Negative Space`, rationale: 'Breathing room separates the focal signal from supporting material.', renderingInstruction: 'Reserve breathing room around the focal text so supporting material does not compete.', cssProperties: ['margin', 'padding'], evidence: { metric: 'focal-to-edge breathing ratio', target: 'focal content has at least 8% edge separation' } }),
  formTypographyRow({ id: 'form-contrast', family: 'form', label: 'Form contrast', disposition: 'supported', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#DESIGN_PRINCIPLES/Contrast`, rationale: 'Perceptible difference clarifies neighboring signals and the intended arc.', renderingInstruction: 'Separate focal and supporting signals through measurable value or scale difference.', cssProperties: ['color', 'background-color'], evidence: { metric: 'text/background luminance contrast', target: 'focal text reaches at least a 4.5:1 contrast ratio' } }),
  formTypographyRow({ id: 'form-golden-ratio', family: 'form', label: 'Golden Ratio', disposition: 'historical', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#COMPOSITION/Golden Ratio`, rationale: 'Historical vocabulary is retained for provenance but has no runtime contract.', renderingInstruction: '', cssProperties: [], evidence: { metric: '', target: '' } }),
  formTypographyRow({ id: 'form-rule-of-thirds', family: 'form', label: 'Rule of Thirds', disposition: 'historical', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#COMPOSITION/Rule of Thirds`, rationale: 'Historical vocabulary is retained for provenance but has no runtime contract.', renderingInstruction: '', cssProperties: [], evidence: { metric: '', target: '' } }),
  formTypographyRow({ id: 'form-balance', family: 'form', label: 'Balance', disposition: 'unsupported', sourceLocator: `${FORM_TYPOGRAPHY_SOURCE}#DESIGN_PRINCIPLES/Balance`, rationale: 'No canonical runtime contract is available; selection must fail closed.', renderingInstruction: '', cssProperties: [], evidence: { metric: '', target: '' } }),
]);

const REQUIRED_CONTRACT_FIELDS = [
  'schema', 'schemaVersion', 'identity', 'domain', 'theory', 'controllableVariables',
  'positiveApplicability', 'negativeApplicability', 'prerequisites', 'compatiblePrinciples',
  'conflictingPrinciples', 'status', 'domainAdapters', 'observablePerceptualEvidence',
  'revisionOperators', 'intentionalViolationRules', 'provenance', 'confidence', 'supersession',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Creative Principle Contract missing ${path}`);
  return value;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Creative Principle Contract missing ${path}`);
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Creative Principle Contract missing ${path}`);
  return value;
}

export function validateCreativePrincipleContract(value: unknown): CreativePrincipleContract {
  if (!isObject(value)) throw new Error('Creative Principle Contract must be an object');
  for (const field of REQUIRED_CONTRACT_FIELDS) if (!(field in value)) throw new Error(`Creative Principle Contract missing ${field}`);
  if (value.schema !== CREATIVE_PRINCIPLE_CONTRACT_SCHEMA) throw new Error('Creative Principle Contract has an invalid schema');
  if (value.schemaVersion !== CREATIVE_PRINCIPLE_CONTRACT_VERSION) throw new Error('Creative Principle Contract has an invalid schemaVersion');
  const identity = value.identity;
  if (!isObject(identity)) throw new Error('Creative Principle Contract missing identity');
  requireString(identity.id, 'identity.id');
  requireString(identity.name, 'identity.name');
  const aliases = requireArray(identity.aliases, 'identity.aliases');
  if (aliases.some((alias) => typeof alias !== 'string' || !alias.trim())) throw new Error('Creative Principle Contract has invalid identity.aliases');
  if (new Set(aliases.map((alias) => normalized(String(alias)))).size !== aliases.length) throw new Error('Creative Principle Contract has duplicate aliases');
  if (aliases.some((alias) => normalized(String(alias)) === normalized(String(identity.id)))) throw new Error('Creative Principle Contract alias duplicates identity.id');
  const domain = value.domain;
  if (!isObject(domain)) throw new Error('Creative Principle Contract missing domain');
  requireString(domain.domain, 'domain.domain');
  requireString(domain.category, 'domain.category');
  const theory = value.theory;
  if (!isObject(theory)) throw new Error('Creative Principle Contract missing theory');
  requireString(theory.claim, 'theory.claim');
  requireString(theory.mechanism, 'theory.mechanism');
  for (const field of ['positiveApplicability', 'negativeApplicability', 'prerequisites', 'compatiblePrinciples', 'conflictingPrinciples']) requireArray(value[field], field);
  if (value.status !== 'hard' && value.status !== 'soft') throw new Error('Creative Principle Contract has invalid status');
  for (const item of requireArray(value.controllableVariables, 'controllableVariables')) { const row = requireObject(item, 'controllableVariables[]'); requireString(row.id, 'controllableVariables[].id'); requireString(row.label, 'controllableVariables[].label'); requireString(row.description, 'controllableVariables[].description'); }
  for (const item of requireArray(value.observablePerceptualEvidence, 'observablePerceptualEvidence')) { const row = requireObject(item, 'observablePerceptualEvidence[]'); requireString(row.id, 'observablePerceptualEvidence[].id'); requireString(row.signal, 'observablePerceptualEvidence[].signal'); requireString(row.description, 'observablePerceptualEvidence[].description'); }
  for (const item of requireArray(value.revisionOperators, 'revisionOperators')) { const row = requireObject(item, 'revisionOperators[]'); requireString(row.id, 'revisionOperators[].id'); requireString(row.label, 'revisionOperators[].label'); requireString(row.operation, 'revisionOperators[].operation'); }
  for (const item of requireArray(value.intentionalViolationRules, 'intentionalViolationRules')) { const row = requireObject(item, 'intentionalViolationRules[]'); requireString(row.rule, 'intentionalViolationRules[].rule'); requireString(row.evidence, 'intentionalViolationRules[].evidence'); }
  const adapters = requireObject(value.domainAdapters, 'domainAdapters');
  if (Object.keys(adapters).length === 0) throw new Error('Creative Principle Contract missing domainAdapters');
  for (const [key, adapter] of Object.entries(adapters)) { const row = requireObject(adapter, `domainAdapters.${key}`); requireString(row.translation, `domainAdapters.${key}.translation`); requireArray(row.controls, `domainAdapters.${key}.controls`); }
  const provenance = requireObject(value.provenance, 'provenance');
  requireString(provenance.curator, 'provenance.curator');
  for (const item of requireArray(provenance.sources, 'provenance.sources')) { const row = requireObject(item, 'provenance.sources[]'); requireString(row.id, 'provenance.sources[].id'); requireString(row.title, 'provenance.sources[].title'); requireString(row.locator, 'provenance.sources[].locator'); }
  const confidence = requireObject(value.confidence, 'confidence');
  if (typeof confidence.score !== 'number' || confidence.score < 0 || confidence.score > 1) throw new Error('Creative Principle Contract has invalid confidence.score');
  requireString(confidence.rationale, 'confidence.rationale');
  const supersession = requireObject(value.supersession, 'supersession');
  if (supersession.state !== 'active' && supersession.state !== 'superseded') throw new Error('Creative Principle Contract has invalid supersession.state');
  return value as unknown as CreativePrincipleContract;
}

// Frozen color / composition row disposition: every frozen COLOR_THEORY and
// COMPOSITION row is enumerated here with an immutable disposition and source
// digest. A supported row points at a contract in CREATIVE_PRINCIPLE_MANIFEST;
// an unsupported row carries a human-readable reason that flows through to the
// Creative Thesis unsupported list, so it is provably unreachable as a
// principle contract.
type ColorCompositionDispositionSeed =
  | { readonly principleId: string; readonly reason?: undefined }
  | { readonly principleId?: undefined; readonly reason: string };

const COLOR_COMPOSITION_DISPOSITION_SEEDS: Readonly<Record<string, ColorCompositionDispositionSeed>> = {
  'color harmony': { principleId: 'color-harmony' },
  'complementary': { reason: 'Frozen recipe row (color wheel pair). The canonical contract for hue relationship lives under color-harmony; the recipe name stays unreachable as a principle contract.' },
  'analogous': { reason: 'Frozen recipe row (color wheel adjacency). The canonical contract for hue relationship lives under color-harmony; the recipe name stays unreachable as a principle contract.' },
  'triadic': { reason: 'Frozen recipe row (three-color wheel set). The canonical contract for hue relationship lives under color-harmony; the recipe name stays unreachable as a principle contract.' },
  'split-complementary': { reason: 'Frozen recipe row (color wheel variant). The canonical contract for hue relationship lives under color-harmony; the recipe name stays unreachable as a principle contract.' },
  'tetradic': { reason: 'Frozen recipe row (color wheel variant). The canonical contract for hue relationship lives under color-harmony; the recipe name stays unreachable as a principle contract.' },
  'warm colors': { reason: 'Frozen hue-family descriptor, not a controllable principle. Temperature bias is reachable via color-harmony; the descriptor stays unreachable as a principle contract.' },
  'cool colors': { reason: 'Frozen hue-family descriptor, not a controllable principle. Temperature bias is reachable via color-harmony; the descriptor stays unreachable as a principle contract.' },
  'saturation': { reason: 'Frozen color attribute, not a controllable principle. Saturation participates as evidence inside color-harmony; the attribute stays unreachable as a principle contract.' },
  'value': { reason: 'Frozen color attribute, not a controllable principle. Value participates as evidence inside contrast; the attribute stays unreachable as a principle contract.' },
  'hue': { reason: 'Frozen color attribute, not a controllable principle. Hue participates inside color-harmony; the attribute stays unreachable as a principle contract.' },
  'hsb/hsl': { reason: 'Frozen technical color model, not a creative principle. The canonical color contract is color-harmony; the model stays unreachable as a principle contract.' },
  'cmyk': { reason: 'Frozen technical print color model, not a creative principle. The canonical color contract is color-harmony; the model stays unreachable as a principle contract.' },
  'grayscale': { reason: 'Frozen single-channel treatment, not a controllable principle. The treatment stays unreachable as a principle contract.' },
  'gradient': { reason: 'Frozen transition tool, not a controllable principle. The tool stays unreachable as a principle contract.' },
  'palette': { reason: 'Frozen collection descriptor, not a controllable principle. Palette size is reachable via color-harmony; the descriptor stays unreachable as a principle contract.' },
  'golden ratio': { reason: 'Frozen numeric proportion recipe, not a controllable creative principle. The recipe stays unreachable as a principle contract.' },
  'rule of thirds': { reason: 'Frozen grid placement recipe, not a controllable creative principle. The recipe stays unreachable as a principle contract.' },
  'symmetry': { reason: 'Frozen formal property, not a controllable creative principle with a cross-domain mechanism. The property stays unreachable as a principle contract.' },
  'asymmetry': { reason: 'Frozen informal-balance descriptor, not a controllable creative principle. Dynamic tension is reachable via contrast; the descriptor stays unreachable as a principle contract.' },
  'leading lines': { reason: 'Frozen visual-flow recipe, not a controllable creative principle. Subject direction is reachable via focal-point; the recipe stays unreachable as a principle contract.' },
  'framing': { reason: 'Frozen crop/border recipe, not a controllable creative principle. Subject isolation is reachable via focal-point; the recipe stays unreachable as a principle contract.' },
  'perspective': { reason: 'Frozen depth-illusion recipe, not a controllable creative principle. Depth participates as evidence inside focal-point; the recipe stays unreachable as a principle contract.' },
  'depth': { reason: 'Frozen layering descriptor, not a controllable creative principle. Depth participates as evidence inside focal-point; the descriptor stays unreachable as a principle contract.' },
  'scale': { reason: 'Frozen size-relationship descriptor, not a controllable creative principle. Scale contrast is reachable via contrast; the descriptor stays unreachable as a principle contract.' },
  'point of view': { reason: 'Frozen vantage descriptor, not a controllable creative principle. Subject placement is reachable via focal-point; the descriptor stays unreachable as a principle contract.' },
  'cropping': { reason: 'Frozen frame-selection tool, not a controllable creative principle. The tool stays unreachable as a principle contract.' },
  'negative space': { principleId: 'negative-space' },
  'visual hierarchy': { reason: 'Frozen ordering recipe, not a controllable creative principle. Subject hierarchy is reachable via focal-point; the recipe stays unreachable as a principle contract.' },
  'focal point': { principleId: 'focal-point' },
};

// Literal release baseline: never derive this from the live knowledge arrays.
const EXPECTED_COLOR_COMPOSITION_SOURCE_DIGESTS: Readonly<Record<string, string>> = {
  'color:Color Harmony': '6f852544860a0b25fa0bfc29cd97d22c6ddea35856dcc8bf72434de7990d374d',
  'color:Complementary': 'b278f3935c15a4fca96d023940d5beec46909268cd15f8389ef464eb0225c1c7',
  'color:Analogous': '2333209313a8201e80d71349442f5e9e9532afae23066bf5d33b03ef21009557',
  'color:Triadic': '2ac6ae2bc862f0e3f52ee5223bc8dae4af6e5b0b175692352fbc17be940585af',
  'color:Split-Complementary': '64260758fb0ab1a4e89cb190771506564ad3efb8dd4ffd008bba155a1d689f9e',
  'color:Tetradic': '9a5c4a94fa7b8883f9cec7354528769a8684901a723af9a94ae60c646973a178',
  'color:Warm Colors': '585ed9045fc37b36098ea348260c292b919d0bebef355d9339e399b7ff375ede',
  'color:Cool Colors': '5e7453d3eefd34045827ba72e7e92c58d08b0bb37d2194eeb3037d46e50a78eb',
  'color:Saturation': 'dc131496cf05f77baa50b3eb90045e4f5b48206f737273124df08e72953fb691',
  'color:Value': '1b4d31ec44571c01c57ecc496406e188c43deece8488f766a09aa8660e7ce454',
  'color:Hue': 'c6b0a89efcba965323658f0285dbcf643d3fd51b407747bf77def7f8eec3421e',
  'color:HSB/HSL': '8361d9241e0a8cbe69f46bce591648f225fc618b0462e77f38036f73930af491',
  'color:CMYK': 'f35a2074de32159d648811604ac93f1425629e7c187e7d26b9a74f904e58b1ba',
  'color:Grayscale': 'b0ba4f91a5bf49f62dcea7f79626d91da448c38e73493f8e6d1afb37d6a3ac78',
  'color:Gradient': '83088c7af3222313b4a3645cead7375d6e844f19c64434ec8c1f668990dbab1f',
  'color:Palette': '29ecb5a3bd24ffdf01127a74a9b446667b72cb9645292ce969a0d699eb06b2e8',
  'composition:Golden Ratio': 'b60da0e75ae1ec66ea4c355b405fc82ee75815cde00e00375da090800cfa0417',
  'composition:Rule of Thirds': 'eba1a7b5ab2c1fedd6fc875bfdccf0b37a84c4541e105344dffda57422f927aa',
  'composition:Symmetry': '0c9a77e00be45f60c5d95e3f7430303337c7e79d16779203a3788cae2f0420c0',
  'composition:Asymmetry': 'df6582df1fdb5fb42afff3c21654c4d9374fa69c23b22fc5a1421cb399f7347e',
  'composition:Leading Lines': 'c3ce8bcc2c4f59f31ad7ea7e8711cbeccc49d017510e9fc406d0b25c148a0ddd',
  'composition:Framing': '88253f62c8fa8f99d4805b86d0c92cf27c58c6a651e8bbca364dbc436308a990',
  'composition:Perspective': '1c3b6c5f78a4d154dfd86f9e0afe61b66b3a3b78da12c7a905854a3dafd3790d',
  'composition:Depth': '9d43cea1142513cd4b6f32141fec27004c2f5e86d8cbc422b1e00b3939146967',
  'composition:Scale': 'a3dcf1b57ffa72d51a0cd0f48e0eccdeb44f7f1e31980277fab8bbaf73ec13ff',
  'composition:Point of View': '06d55024d61e26f9dc7b4966efdda7979198f9e71297a3edbcf0181425f9a422',
  'composition:Cropping': 'fac1b9833d8f6be0bbe9a146254f25875d9c0b787472273dece1ad47b440ae1c',
  'composition:Negative Space': '94fac6dfece3bef22df542b0a588358ac41c406aef3f6a5541e317492f379b6b',
  'composition:Visual Hierarchy': 'cc47f9c15b2065e2d7d9ac6adfbda9edf7178c0a56c46c14669b3e5b67932955',
  'composition:Focal Point': '4dbf1ff89741a3b2fe7e608064a677d092883404ee6ff6349d5a42daa2d2ce61',
};

function rowKey(name: string): string {
  return normalized(name);
}

function rowDigest(rowType: ColorCompositionRowType, name: string, description: string, keywords: readonly string[]): string {
  return digest(`${rowType}|${name}|${description}|[${keywords.join(',')}]`);
}

function buildFrozenSourceRows(): readonly ColorCompositionSourceRow[] {
  const out: ColorCompositionSourceRow[] = [];
  for (const row of COLOR_THEORY) {
    const sourceDigest = rowDigest('color', row.name, row.description, row.keywords);
    out.push(deepFreeze({
      source: COLOR_COMPOSITION_MANIFEST_SCHEMA,
      sourceVersion: COLOR_COMPOSITION_MANIFEST_VERSION,
      rowType: 'color',
      name: row.name,
      description: row.description,
      keywords: [...row.keywords],
      sourceDigest,
    }));
  }
  for (const row of COMPOSITION) {
    const sourceDigest = rowDigest('composition', row.name, row.description, row.keywords);
    out.push(deepFreeze({
      source: COLOR_COMPOSITION_MANIFEST_SCHEMA,
      sourceVersion: COLOR_COMPOSITION_MANIFEST_VERSION,
      rowType: 'composition',
      name: row.name,
      description: row.description,
      keywords: [...row.keywords],
      sourceDigest,
    }));
  }
  const actualKeys = out.map((row) => `${row.rowType}:${row.name}`);
  const expectedKeys = Object.keys(EXPECTED_COLOR_COMPOSITION_SOURCE_DIGESTS);
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error('Frozen color/composition source baseline drift: row added, removed, or renamed');
  }
  for (const row of out) {
    const key = `${row.rowType}:${row.name}`;
    if (row.sourceDigest !== EXPECTED_COLOR_COMPOSITION_SOURCE_DIGESTS[key]) {
      throw new Error(`Frozen color/composition source baseline drift: ${key} description or keywords changed`);
    }
  }
  return out;
}

export const COLOR_COMPOSITION_SOURCE_ROWS: readonly ColorCompositionSourceRow[] = deepFreeze(buildFrozenSourceRows());

function buildDispositionMatrix(): readonly ColorCompositionDispositionEntry[] {
  return COLOR_COMPOSITION_SOURCE_ROWS.map((row) => {
    const seed = COLOR_COMPOSITION_DISPOSITION_SEEDS[rowKey(row.name)];
    if (seed && seed.principleId) {
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[seed.principleId];
      if (!contract) throw new Error(`Color/composition disposition references missing contract ${seed.principleId}`);
      const contractDigest = digest(projectCreativePrinciple(contract));
      return deepFreeze({
        row,
        principleId: seed.principleId,
        contractDigest,
        sourceDigest: row.sourceDigest,
        disposition: 'supported',
      });
    }
    const reason = seed?.reason ?? 'Frozen row not promoted into a canonical Creative Principle Contract; rows that name a recipe, tool, or attribute are dispositioned unsupported so they remain unreachable as principle contracts.';
    return deepFreeze({
      row,
      principleId: null,
      contractDigest: '',
      sourceDigest: row.sourceDigest,
      disposition: 'unsupported',
      reason,
    });
  });
}

export const COLOR_COMPOSITION_DISPOSITION_MATRIX: readonly ColorCompositionDispositionEntry[] = deepFreeze(buildDispositionMatrix());

const MUSIC_SOUND_SOURCE_DIGESTS: Readonly<Record<string, string>> = {
  'p5:Sound Synthesis': 'bd97b8115c81c264b7ef27c09afa3798dcdee7ed8e0ef39a11fac11ebe253096',
  'three:Audio Integration': '6dc435cdaa7bb6e680a792b05962cd19bb3e89369cb24c557ccec6ca724b81d5',
  'strudel:Pattern Sequencing': 'b93cb0828705a0c7be884ec666d644cae0d0ea4cffc072bec83029f048a04eda',
  'strudel:Temporal Modulation': 'e50e66603d921821bd9f724d49efa742bfc16ba9d20f842df5baf0a9a1a81c0f',
  'strudel:Stack-based Composition': '9dd51e90d3d15fac351c4fc2fd34141a3d8df73907e569c93be1185c7ae8169e',
  'strudel:Rhythm Patterns': '896341b7e7a241602ff6da0b8d87cb59e76275e0951ddb3ff4444ff653f6abc8',
  'strudel:Melody Generation': '93c0afbd5ce7aefad0e98db5e8a1ac39e82303d3655039eda2a468b22d6fd69d',
  'strudel:Harmonic Progression': 'f160d8287d5295101ad2d440a0f3af01eb0a89ff99f4c169f068a9f4f47a3fb3',
  'strudel:Timbre Design': '0778b5ff9ef0dd490c417a70d8b42baa382251ed433cbcf39231f0345ba8d6d5',
  'strudel:Spatial Audio': '5a30b42f54dc7448cb2465898bf2c631caeb991672778eae27a7229680e2b6d1',
  'strudel:Microtiming': 'cc50f350f19668893c19d2257f385a0806cd43941928f3794aa0d8cd6f1fd0bc',
  'strudel:Sample Manipulation': 'b908cdda4a052a376b92b33cfac70332ee32558b11f0077b1ed72a5841614186',
  'strudel:Probability and Chance': '32365f602acc5a3d94326385650f99c2432b1143135030c917f40f2d19ad2fa6',
  'strudel:State Machines': '02865f861c6a3bb976b9a31a53e24a2f0edf600d14428e9d819c15b8ba9081a4',
  'strudel:Pattern Algebra': 'd94725d2642db2ad9bc325ca5bcb7026dd804fdd82606b0873efae925d333f0d',
  'strudel:Iterative Processes': '4f221458fc385086b64c33d8f8f5f13f45773675f2c96bc3ab118924b4abd32e',
  'strudel:Modulation Chains': 'ba5b42e4ee4410ddd2c8d67aceeab4385cacd60578b2c989c8410c051fb85f18',
  'strudel:Global Effects': 'ab427ac9c92c88774996c38dd2cc53def40fcd006d8c26c4152247df08981343',
  'strudel:Live Coding Patterns': '0ed58565e791da350dd19419487bf99bbdb0cade2bfa1c1f331196e7f4cc42df',
  'strudel:Algorithmic Composition': '0e93d1b3df5ba5dc9477c86536b0d8ca9d65e2e79e89b4c6b4385d3fb4e2ba56',
  'tone:Tone.js Initialization': '5f1fb5f86e8f7f27422a622b6500f652bec49706bc4429dc4e98b68b2bd70408',
  'tone:Synth Types': '688e78ec275135fa216ea8c4baa15a383b70af6722af6a1bbc0e8664bb49efaf',
  'tone:Oscillators': '7015c020e94ed3576704358735dccf571731ca9479072228afd2e1487a89ed1f',
  'tone:ADSR Envelopes': '4df1c936c20617ae72a8210b26b7a6c73653f00b38a5698b843dca560e9f1c6c',
  'tone:Polyphonic Synthesis': '5cd41f6b8e29c298aff46b80dcc27339edb03c1cdd543fa44d9d8f52af1c68dd',
  'tone:Effects - Reverb': 'bb3968d6f1d00a2ca983a101161eddfee75c8bfdbee485e59cb2a25fae6f8bf9',
  'tone:Effects - Delay': '8fd873319815b6df020fc208d345682b092bc7516d3e78567bbba0130211be93',
  'tone:Effects Chain': '2a4d86aab26f7913c5b73e52357281b825a0d6dcdfd680170c5c361a2a93028a',
  'tone:Sequencing - Tone.Loop': 'cf61299108aac488a170c3308cdb77c38f9ef61d5fccda01ed8b5841ac8f7ac5',
  'tone:Sequencing - Tone.Sequence': 'f86f0a7744b60ed929adde25f5c3ee4f3f20139d08f5a17f48ee19d36f754f6c',
  'tone:Sequencing - Tone.Part': '586d300c04883d3576dfbdaaa0cc14c3fd5941e3eddbfd1928caa0b2f59593a1',
  'tone:Transport System': '35aa3a84b9ca10bd7ee068d5b796c983937bb4c287ae8200503d7db03ab77b0e',
  'tone:Chord Progressions': '1ea123212ac1f5f746bd132ac623cbcb3cc1336c33a81f6b3a01c48b9b07e5b9',
  'tone:Arpeggios': '0b6b18491b3623532592175d617aff825135731c279c71c35d4aeebd7ed55ddd',
  'tone:Scales and Modes': 'eb0720fb9beb23a15e6c7872d426169fb68bf3f661bf427030b4b365ed8b587a',
  'tone:Filter Modulation': 'c19b393e2c7a679718e775d22e46dc632cf99ca0a6dd2d48622a533d00fbb3f0',
  'tone:LFO Modulation': '5eb48677cec6b189e0309ae45606920540db1b45c30b7c5ef7700b1a0e3eeb29',
  'tone:Memory Nodes': '7b4bb23f54557ee1488cfee1d65ae36f9fe9c0b72db79e0025f05f7c4ca5dc01',
  'tone:Sample Instruments': '54bd7abdad2f7207a20743288513b2e003a8919f0c0603966806a5f14768eb77',
  'tone:Noise Generation': 'ff78ed8a08076fb0558de3f82c2fb1cc19d1b2b616862681d429578c43b0117e',
  'tone:Analyser and Visualization': '9c15415269316f1c900e3c8a1f5d95129e82c2e1b9b375a2a6483747097cc94a',
  'tone:Volume and Dynamics': '8476f43c8ee55d346f056b38cc8d8380a16937c60d2b439fb87b394acb13942e',
  'tone:Panning and Spatialization': '25d69c5be0049180c9c78bba1fd525726c8cf84b5eac824bacbdf64054786d68',
  'tone:Musical Timing': '2a86fb36226baa4bb9dd112bcb959519ef2c3b6a2f093bd9e026ff339cfa6dc5',
  'tone:Ambient Pad Synthesis': 'ef453d3849562f520827bc5e3160cc42f98e3ffddb42d8810765d190426ac8d2',
  'tone:Bass Synthesis': 'ce578f557f043fc0488dcc38147dd5bf9efd5ca6b6d13723dea899cbe97a88d6',
  'tone:Lead Synthesis': '17b39a8d9635db97371fedfa2d43b08fb7d7e32e11602024064fc787eac810d3',
};

const MUSIC_SOUND_SUPPORTED_ROWS: Readonly<Record<string, string>> = {
  'p5:Sound Synthesis': 'music-timbre', 'strudel:Pattern Sequencing': 'music-rhythm',
  'strudel:Rhythm Patterns': 'music-rhythm', 'strudel:Melody Generation': 'music-harmony',
  'strudel:Harmonic Progression': 'music-harmony', 'strudel:Timbre Design': 'music-timbre',
  'tone:Oscillators': 'music-timbre', 'tone:ADSR Envelopes': 'music-dynamics',
  'tone:Polyphonic Synthesis': 'music-harmony', 'tone:Sequencing - Tone.Sequence': 'music-rhythm',
  'tone:Transport System': 'music-rhythm', 'tone:Chord Progressions': 'music-harmony',
  'tone:Scales and Modes': 'music-harmony', 'tone:Volume and Dynamics': 'music-dynamics',
  'tone:Musical Timing': 'music-rhythm',
};

function musicSourceDigest(domain: MusicSoundRowDomain, name: string, description: string, keywords: readonly string[]): string {
  return digest(`${domain}|${name}|${description}|[${keywords.join(',')}]`);
}

function buildMusicSoundSourceRows(): readonly MusicSoundSourceRow[] {
  const rows: MusicSoundSourceRow[] = [];
  for (const domain of ['p5', 'three', 'strudel', 'tone'] as const) {
    for (const source of ARTISTIC_TECHNIQUES[domain]) {
      if (domain !== 'strudel' && domain !== 'tone' && !/sound|audio/i.test(source.name)) continue;
      const sourceDigest = musicSourceDigest(domain, source.name, source.description, source.keywords);
      const baseline = MUSIC_SOUND_SOURCE_DIGESTS[`${domain}:${source.name}`];
      if (!baseline || sourceDigest !== baseline) throw new Error(`Frozen music/sound source baseline drift: ${domain}:${source.name}`);
      rows.push(deepFreeze({ source: MUSIC_SOUND_MANIFEST_SCHEMA, sourceVersion: MUSIC_SOUND_MANIFEST_VERSION, domain, name: source.name, description: source.description, keywords: [...source.keywords], sourceDigest }));
    }
  }
  if (!isDeepStrictEqual(rows.map((row) => `${row.domain}:${row.name}`), Object.keys(MUSIC_SOUND_SOURCE_DIGESTS))) throw new Error('Frozen music/sound source baseline drift: row added, removed, or renamed');
  return rows;
}

export const MUSIC_SOUND_SOURCE_ROWS: readonly MusicSoundSourceRow[] = deepFreeze(buildMusicSoundSourceRows());

function buildMusicSoundDispositionMatrix(): readonly MusicSoundDispositionEntry[] {
  return MUSIC_SOUND_SOURCE_ROWS.map((row) => {
    const key = `${row.domain}:${row.name}`;
    const contractId = MUSIC_SOUND_SUPPORTED_ROWS[key];
    if (contractId) return deepFreeze({ row, contractId, contractDigest: digest(projectCreativePrinciple(CREATIVE_PRINCIPLE_MANIFEST.contracts[contractId])), sourceDigest: row.sourceDigest, disposition: 'supported', runtimePath: 'src/music/generateMusic.ts#generateMusic', scenarioIds: [`music-row-${normalized(row.name)}`, `music-contract-${contractId}`] });
    return deepFreeze({ row, contractId: null, contractDigest: '', sourceDigest: row.sourceDigest, disposition: 'unsupported', runtimePath: null, scenarioIds: [], reason: 'Historical or unsupported technique: no deterministic runtime scenario proves this row reachable without an unmeasured provider or sample dependency.' });
  });
}

export const MUSIC_SOUND_DISPOSITION_MATRIX: readonly MusicSoundDispositionEntry[] = deepFreeze(buildMusicSoundDispositionMatrix());
export const MUSIC_SOUND_SUPPORTED_CONTRACT_IDS = ['music-rhythm', 'music-harmony', 'music-dynamics', 'music-timbre'] as const;

export function musicSoundDispositionFor(input: string): MusicSoundDispositionEntry {
  const key = normalized(input);
  const entry = MUSIC_SOUND_DISPOSITION_MATRIX.find((candidate) => normalized(candidate.row.name) === key);
  if (entry) return entry;
  const contract = Object.values(CREATIVE_PRINCIPLE_MANIFEST.contracts).find((candidate) => candidate.identity.id === input
    || normalized(candidate.identity.name) === key
    || candidate.identity.aliases.some((alias) => normalized(alias) === key));
  if (contract && contract.identity.id.startsWith('music-')) return MUSIC_SOUND_DISPOSITION_MATRIX.find((candidate) => candidate.contractId === contract.identity.id)!;
  const unknownDigest = digest(`unknown-music-sound|${input}`);
  return deepFreeze({ row: deepFreeze({ source: MUSIC_SOUND_MANIFEST_SCHEMA, sourceVersion: MUSIC_SOUND_MANIFEST_VERSION, domain: 'tone', name: input.trim(), description: '', keywords: [], sourceDigest: unknownDigest }), contractId: null, contractDigest: '', sourceDigest: unknownDigest, disposition: 'unsupported', runtimePath: null, scenarioIds: [], reason: 'No frozen music/sound row or canonical contract is reachable for this request.' });
}

export function resolveMusicSoundContract(input: string): CreativePrincipleContract | undefined {
  const entry = musicSoundDispositionFor(input);
  return entry.contractId ? CREATIVE_PRINCIPLE_MANIFEST.contracts[entry.contractId] : undefined;
}

export function principleDispositionFor(input: string): ColorCompositionDispositionEntry {
  const key = rowKey(input);
  const entry = COLOR_COMPOSITION_DISPOSITION_MATRIX.find((candidate) => rowKey(candidate.row.name) === key);
  if (entry) return entry;
  const unknownDigest = digest(`unknown|${input}`);
  return deepFreeze({
    row: deepFreeze({
      source: COLOR_COMPOSITION_MANIFEST_SCHEMA,
      sourceVersion: COLOR_COMPOSITION_MANIFEST_VERSION,
      rowType: 'color',
      name: input.trim(),
      description: '',
      keywords: [],
      sourceDigest: unknownDigest,
    }),
    principleId: null,
    contractDigest: '',
    sourceDigest: unknownDigest,
    disposition: 'unsupported',
    reason: 'Frozen row is not present in the color / composition disposition matrix; no canonical Creative Principle Contract is reachable.',
  });
}
export function validateFormTypographyManifest(value: unknown): readonly FormTypographyRow[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Form/typography manifest must be non-empty');
  const ids = new Set<string>();
  for (const row of value) {
    if (!isObject(row) || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new Error('Form/typography manifest has an invalid or duplicate row');
    ids.add(row.id);
    if (!['form', 'typography'].includes(String(row.family)) || typeof row.label !== 'string' || !row.label.trim() || typeof row.sourceLocator !== 'string' || !row.sourceLocator.trim() || typeof row.rationale !== 'string' || !row.rationale.trim()) throw new Error(`Form/typography row ${row.id} has invalid identity`);
    if (!['supported', 'historical', 'unsupported'].includes(String(row.disposition))) throw new Error(`Form/typography row ${row.id} has no immutable disposition`);
    const supported = row.disposition === 'supported';
    if (!isObject(row.reachability) || !Array.isArray(row.reachability.createEntryPoints) || !Array.isArray(row.reachability.generatorDomains)) throw new Error(`Form/typography row ${row.id} has invalid reachability`);
    if (!isObject(row.rendering) || typeof row.rendering.instruction !== 'string' || !Array.isArray(row.rendering.cssProperties) || !Array.isArray(row.scenarioCoverage) || !Array.isArray(row.perceptualEvidence) || !isObject(row.boundedRevision)) throw new Error(`Form/typography row ${row.id} has invalid coverage`);
    if (row.scenarioCoverage.some((item) => !isObject(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.prompt !== 'string' || !item.prompt.trim() || typeof item.expectedEvidence !== 'string' || !item.expectedEvidence.trim())) throw new Error(`Form/typography row ${row.id} has invalid scenario coverage`);
    if (row.perceptualEvidence.some((item) => !isObject(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.metric !== 'string' || !item.metric.trim() || typeof item.target !== 'string' || !item.target.trim())) throw new Error(`Form/typography row ${row.id} has invalid perceptual evidence`);
    if (!Object.isFrozen(row) || !Object.isFrozen(row.reachability) || !Object.isFrozen(row.boundedRevision)) throw new Error(`Form/typography row ${row.id} has a mutable disposition`);
    if (supported && (row.reachability.createEntryPoints.length === 0 || row.reachability.generatorDomains.length === 0 || row.scenarioCoverage.length === 0 || row.perceptualEvidence.length === 0 || row.boundedRevision.maxAttempts !== 1)) throw new Error(`Supported form/typography row ${row.id} is not executable and covered`);
    if (!supported && (row.reachability.createEntryPoints.length > 0 || row.reachability.generatorDomains.length > 0 || row.boundedRevision.maxAttempts !== 0)) throw new Error(`Non-runtime form/typography row ${row.id} entered runtime coverage`);
  }
  return value as readonly FormTypographyRow[];
}

// ----- W8-09 interaction / accessibility manifest -----
//
// Frozen disposition for every row in INTERACTION_A11Y. Supported rows point
// at a Creative Principle Contract with a cross-domain mechanism and
// measurable evidence; historical rows are kept for provenance without a
// runtime contract; unsupported rows have no contract and fail closed before
// provider reservation. The matrix is the single source of truth — adding,
// removing, or renaming a row throws a deterministic drift error.

function interactionAccessibilityRowDigest(rowType: InteractionA11yRowType, name: string, description: string, keywords: readonly string[]): string {
  return digest(`${rowType}|${name}|${description}|[${keywords.join(',')}]`);
}

function buildInteractionA11ySourceRows(): readonly InteractionA11ySourceRow[] {
  const out: InteractionA11ySourceRow[] = [];
  for (const row of INTERACTION_A11Y) {
    // All W8-09 rows live under the interaction family in the frozen source.
    const sourceDigest = interactionAccessibilityRowDigest('interaction', row.name, row.description, row.keywords);
    out.push(deepFreeze({
      source: INTERACTION_A11Y_MANIFEST_SCHEMA,
      sourceVersion: INTERACTION_A11Y_MANIFEST_VERSION,
      rowType: 'interaction',
      name: row.name,
      description: row.description,
      keywords: [...row.keywords],
      sourceDigest,
    }));
  }
  return out;
}

export const INTERACTION_A11Y_SOURCE_ROWS: readonly InteractionA11ySourceRow[] = deepFreeze(buildInteractionA11ySourceRows());

type InteractionA11ySeed =
  | { readonly principleId: string; readonly disposition: 'supported'; readonly reason?: undefined }
  | { readonly disposition: 'historical'; readonly reason: string }
  | { readonly disposition: 'unsupported'; readonly reason: string };

const INTERACTION_A11Y_DISPOSITION_SEEDS: Readonly<Record<string, InteractionA11ySeed>> = {
  'keyboard operation': { principleId: 'keyboard-operation', disposition: 'supported' },
  'focus visibility': { principleId: 'focus-visibility', disposition: 'supported' },
  'focus order': { principleId: 'focus-order', disposition: 'supported' },
  'semantic naming': { principleId: 'semantic-naming', disposition: 'supported' },
  'semantic state': { principleId: 'semantic-state', disposition: 'supported' },
  'reduced motion': { principleId: 'reduced-motion', disposition: 'supported' },
  'mouse drag': { disposition: 'historical', reason: 'Frozen gesture vocabulary retained for provenance; no canonical Creative Principle Contract — drag is a pointer primitive, not a cross-domain principle.' },
  'touch swipe': { disposition: 'historical', reason: 'Frozen gesture vocabulary retained for provenance; no canonical Creative Principle Contract — swipe is a touch primitive, not a cross-domain principle.' },
  'tap': { disposition: 'historical', reason: 'Frozen activation primitive retained for provenance; no canonical Creative Principle Contract — tap is a contact primitive, not a cross-domain principle.' },
  'hover': { disposition: 'historical', reason: 'Frozen pointer primitive retained for provenance; no canonical Creative Principle Contract — hover is a pointer-over event, not a cross-domain principle.' },
  'pinch': { disposition: 'historical', reason: 'Frozen gesture vocabulary retained for provenance; no canonical Creative Principle Contract — pinch is a multi-touch primitive, not a cross-domain principle.' },
  'click': { disposition: 'historical', reason: 'Frozen activation primitive retained for provenance; no canonical Creative Principle Contract — click is a pointer activation, not a cross-domain principle.' },
  'focus ring': { disposition: 'historical', reason: 'Frozen visual focus primitive retained for provenance; the canonical contract is focus-visibility; the primitive remains unreachable as a principle contract.' },
  'aria live region': { disposition: 'historical', reason: 'Frozen accessible live region primitive retained for provenance; no canonical Creative Principle Contract — announce-primitive, not a cross-domain principle.' },
  'screen reader bypass': { disposition: 'historical', reason: 'Frozen skip-link primitive retained for provenance; no canonical Creative Principle Contract — bypass-primitive, not a cross-domain principle.' },
  'form submit': { disposition: 'historical', reason: 'Frozen activation primitive retained for provenance; no canonical Creative Principle Contract — submit-primitive, not a cross-domain principle.' },
  'checkbox toggle': { disposition: 'historical', reason: 'Frozen two-state primitive retained for provenance; the canonical contract is semantic-state; the primitive remains unreachable as a principle contract.' },
  'color independence': { disposition: 'unsupported', reason: 'Frozen accessibility phrase with no canonical Creative Principle Contract; remain unreachable so requests fail closed before provider reservation.' },
  'cognitive load': { disposition: 'unsupported', reason: 'Frozen accessibility phrase with no canonical Creative Principle Contract; remain unreachable so requests fail closed before provider reservation.' },
  'multi-modal input': { disposition: 'unsupported', reason: 'Frozen vocabulary phrase with no canonical Creative Principle Contract; remain unreachable so requests fail closed before provider reservation.' },
};

function buildInteractionA11yDispositionMatrix(): readonly InteractionA11yDispositionEntry[] {
  return INTERACTION_A11Y_SOURCE_ROWS.map((row) => {
    const seed = INTERACTION_A11Y_DISPOSITION_SEEDS[rowKey(row.name)];
    if (seed && seed.disposition === 'supported') {
      const contract = CREATIVE_PRINCIPLE_MANIFEST.contracts[seed.principleId];
      if (!contract) throw new Error(`Interaction/a11y disposition references missing contract ${seed.principleId}`);
      const contractDigest = digest(projectCreativePrinciple(contract));
      return deepFreeze({
        row,
        principleId: seed.principleId,
        contractDigest,
        sourceDigest: row.sourceDigest,
        disposition: 'supported',
      });
    }
    const fallback = seed ?? {
      disposition: 'unsupported' as const,
      reason: 'Frozen row is not present in the interaction/a11y disposition matrix; no canonical Creative Principle Contract is reachable.',
    };
    return deepFreeze({
      row,
      principleId: null,
      contractDigest: '',
      sourceDigest: row.sourceDigest,
      disposition: fallback.disposition,
      reason: fallback.reason,
    });
  });
}

export const INTERACTION_A11Y_DISPOSITION_MATRIX: readonly InteractionA11yDispositionEntry[] = deepFreeze(buildInteractionA11yDispositionMatrix());

export function interactionAccessibilityDispositionFor(input: string): InteractionA11yDispositionEntry {
  const key = rowKey(input);
  const entry = INTERACTION_A11Y_DISPOSITION_MATRIX.find((candidate) => rowKey(candidate.row.name) === key);
  if (entry) return entry;
  const unknownDigest = digest(`unknown|${input}`);
  return deepFreeze({
    row: deepFreeze({
      source: INTERACTION_A11Y_MANIFEST_SCHEMA,
      sourceVersion: INTERACTION_A11Y_MANIFEST_VERSION,
      rowType: 'interaction',
      name: input.trim(),
      description: '',
      keywords: [],
      sourceDigest: unknownDigest,
    }),
    principleId: null,
    contractDigest: '',
    sourceDigest: unknownDigest,
    disposition: 'unsupported',
    reason: 'Frozen row is not present in the interaction/a11y disposition matrix; no canonical Creative Principle Contract is reachable.',
  });
}

// ----- W8-09 expected-digest baseline -----
//
// Literal release baseline: never derive this from the live knowledge array.
// Any drift on the INTERACTION_A11Y source throws a deterministic error so
// the matrix cannot silently absorb a contract change.

const EXPECTED_INTERACTION_A11Y_SOURCE_DIGESTS: Readonly<Record<string, string>> = {
  'interaction:Keyboard Operation': '00b83768bbdd98b70b427d60023697ae78f9006c45bf6be284e2013c5191c300',
  'interaction:Focus Visibility': 'c7dd4349bdc8c77882dc6e885dfcf5820a7556c98f9ca8b7e0c9dd25c11844f3',
  'interaction:Focus Order': '5a401e2f36be18c91d6eea9f3375bc5f691ef1b225c4ec9c5ed540ac9b0a370b',
  'interaction:Semantic Naming': '7d2bdbc8eed48de09d4cdd0139f749ef63ed9f2476987cefc21a1141f7ee0981',
  'interaction:Semantic State': 'ad6eaf6c76dece1e322bf31035c5082de2c4bae596e4d712adc2aadabbf88c82',
  'interaction:Reduced Motion': 'c9fc2b1a91e5a2274d488c9f4c7f46a49b2d8a67deaacfb29ac20616eceaeee1',
  'interaction:Mouse Drag': 'b53efeb7726c97721b5de0a0729ff861c9dea6d3a9f2186957ad8d201fb93106',
  'interaction:Touch Swipe': '25490a24d72f10098b27dd013be6f60899843093b48ded10ee215b3f4535eb94',
  'interaction:Tap': 'ca2924617340b9164898e90630a098671677112ec55393c4066cd205841c3ae4',
  'interaction:Hover': 'd3cf263cd91906878bdad5cba8180f74383dbf21414694adc2eba61cbf5a3425',
  'interaction:Pinch': '01969d343c7b91f4b214b9dc18a75ec4f19d56a99d282f4f0d6169f81574e75b',
  'interaction:Click': '8d6e2eccf42e7852158e70e76797cdb5ea9020388816c52cccba9bd95a4f4a3f',
  'interaction:Focus Ring': 'd16b897f3c8a9450dc6269157516b56b7b6b8cc023809a5c3350a26dac614909',
  'interaction:ARIA Live Region': 'ed02ef1be1278a0cd04b43205b3903f957f7c74049110cab37853ae11eabaf0e',
  'interaction:Screen Reader Bypass': '3bc1f39494c0bc6484be90069ced1fdfa48f445bb5feef0ec6926e6c43788c57',
  'interaction:Form Submit': '9d561e3c5c67115e3d0f63e0cbef34e822881c265723fb6d5bc5c1a3e71cc581',
  'interaction:Checkbox Toggle': '27b25c3563436206096e320c5930fadca3aa793385c3007fd41d0d988ff99a39',
  'interaction:Color Independence': 'c0933097c9a8184bb361a654099a0ca5f47e2fc814d960604214ceb39f4a2ff4',
  'interaction:Cognitive Load': '99fe83d121a2527573030f97e1bc2afc98d8f31935b4e969ae890030a5dd406a',
  'interaction:Multi-Modal Input': 'c9f51c2344ca733c94ed63b581bdf119061c3deaa9da36087eae9d5f949a7686',
};

function assertInteractionA11yBaseline(): void {
  const actualKeys = INTERACTION_A11Y_SOURCE_ROWS.map((row) => `interaction:${row.name}`);
  const expectedKeys = Object.keys(EXPECTED_INTERACTION_A11Y_SOURCE_DIGESTS);
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error('Frozen interaction/a11y source baseline drift: row added, removed, or renamed');
  }
  for (const row of INTERACTION_A11Y_SOURCE_ROWS) {
    const key = `interaction:${row.name}`;
    if (row.sourceDigest !== EXPECTED_INTERACTION_A11Y_SOURCE_DIGESTS[key]) {
      throw new Error(`Frozen interaction/a11y source baseline drift: ${key} description or keywords changed`);
    }
  }
}

assertInteractionA11yBaseline();


function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
}

export function resolveCreativePrinciple(input: string): CreativePrincipleContract | undefined {
  const key = normalized(input);
  for (const contract of Object.values(CREATIVE_PRINCIPLE_MANIFEST.contracts)) {
    if (normalized(contract.identity.id) === key || normalized(contract.identity.name) === key) return contract;
    if (contract.identity.aliases.some((alias) => normalized(alias) === key)) return contract;
  }
  for (const id of Object.keys(MOTION_TEMPORAL_CONTRACTS) as Array<keyof typeof MOTION_TEMPORAL_CONTRACTS>) {
    const contract = MOTION_TEMPORAL_CONTRACTS[id];
    if (normalized(contract.identity.id) === key || normalized(contract.identity.name) === key) return contract;
    if (contract.identity.aliases.some((alias) => normalized(alias) === key)) return contract;
  }
  return undefined;
}

function projectionLines(contract: CreativePrincipleContract): string[] {
  const sorted = (items: readonly string[]) => [...items].sort((a, b) => a.localeCompare(b));
  return [
    `Creative Principle Contract: ${contract.identity.name} (${contract.identity.id})`,
    `Schema: ${contract.schema} v${contract.schemaVersion}`,
    `Aliases: ${sorted(contract.identity.aliases).join(', ')}`,
    `Domain: ${contract.domain.domain} / ${contract.domain.category}`,
    `Status: ${contract.status}`,
    `Theory: ${contract.theory.claim}`,
    `Mechanism: ${contract.theory.mechanism}`,
    `Controllable variables: ${contract.controllableVariables.map((item) => `${item.id} — ${item.description}`).join('; ')}`,
    `Positive applicability: ${sorted(contract.positiveApplicability).join(' | ')}`,
    `Negative applicability: ${sorted(contract.negativeApplicability).join(' | ')}`,
    `Prerequisites: ${sorted(contract.prerequisites).join(' | ')}`,
    `Compatible principles: ${sorted(contract.compatiblePrinciples).join(', ')}`,
    `Conflicting principles: ${sorted(contract.conflictingPrinciples).join(', ')}`,
    `Domain adapters: ${Object.keys(contract.domainAdapters).sort().map((key) => `${key} — ${contract.domainAdapters[key].translation}`).join(' | ')}`,
    `Observable evidence: ${contract.observablePerceptualEvidence.map((item) => `${item.id} — ${item.description}`).join('; ')}`,
    `Revision operators: ${contract.revisionOperators.map((item) => `${item.id} — ${item.operation}`).join('; ')}`,
    `Intentional violations: ${contract.intentionalViolationRules.map((item) => `${item.rule} Evidence: ${item.evidence}`).join('; ')}`,
    `Provenance: ${contract.provenance.sources.map((source) => `${source.id} (${source.locator})`).join(', ')}; curator ${contract.provenance.curator}`,
    `Confidence: ${contract.confidence.score.toFixed(2)} — ${contract.confidence.rationale}`,
    `Supersession: ${contract.supersession.state}${contract.supersession.supersededBy ? ` by ${contract.supersession.supersededBy}` : ''}`,
  ];
}

export function projectCreativePrinciple(contract: CreativePrincipleContract): string {
  validateCreativePrincipleContract(contract);
  return projectionLines(contract).join('\n');
}

export function detectProjectionSourceDrift(contract: CreativePrincipleContract, projection: string): ProjectionDriftReport {
  const expected = projectCreativePrinciple(contract);
  return { drift: expected !== projection, expected, actual: projection, expectedDigest: digest(expected), actualDigest: digest(projection) };
}

export const projectCreativePrincipleContract = projectCreativePrinciple;
export const detectProjectionDrift = detectProjectionSourceDrift;

// Every frozen color/composition row name is now an unreachable principle
// contract; the unsupported detection only needs to flag generic named
// requests that the matrix would also flag (kept for the existing fallback
// pathway). The selected rows below are listed only to make the fallthrough
// visible — the canonical answer flows through COLOR_COMPOSITION_DISPOSITION_MATRIX.
const UNSUPPORTED_TERMS = [
  'chiaroscuro', 'golden ratio', 'rule of thirds', 'symmetry', 'balance', 'unity',
  'color independence', 'cognitive load', 'multi-modal input',
];
// Time-based motion/temporal phrases that select a motion/time principle.
// These require explicit time-based motion language so that an ordinary-language
// brief naming general rhythm/pulse still selects the cross-domain rhythm
// contract, while a brief naming a time-based arc or cadence selects the
// motion/time principle. Rhythm is checked first so a brief naming pulse/beat
// with time-based language wins over the more general "over time" arc match.
const TEMPORAL_ARC_KEYWORDS = /\b(?:time[- ]based(?:.*(?:arc|evolv|stillness|release|opening|development))?|temporal arc|frame sequence|evolving over time|sample schedule|opening to release|begin(?:ning)?(?: to release)?|development (?:samples?|frames?)|release samples?|sample frames?|sample sequence|development frames?|stillness into .* release)\b/i;
const TEMPORAL_RHYTHM_KEYWORDS = /\b(?:temporal rhythm|time[- ]based(?:.*(?:pulse|beat|cadence|tick))|pulse over time|beat schedule|sample pulse|temporal cadence|motion sample sequence|steady beats?(?:.*(?:duration|over time|across))|steady (?:pulse|beat) over time|pulse across the duration|beats? that pulse|rhythm that pulses?|(?:pulse|beat|cadence).*(?:samples?|schedule|over time|duration))\b/i;
// Frozen selection rules drive which supported contract is chosen for a brief.
// Order matters: more specific principles (motion/temporal, focal-point) take
// priority over the generic contrast contract.
const PRINCIPLE_SELECTION_RULES: ReadonlyArray<{ readonly id: string; readonly match: RegExp; readonly source: 'manifest' | 'motion-temporal' }> = [
  { id: 'temporal-rhythm', match: TEMPORAL_RHYTHM_KEYWORDS, source: 'motion-temporal' },
  { id: 'temporal-arc', match: TEMPORAL_ARC_KEYWORDS, source: 'motion-temporal' },
  { id: 'focus-visibility', match: /\bfocus\s+visibility\b|\bfocus\s+indicator\b|\bvisible\s+focus\b|\bfocus\s+ring\b/i, source: 'manifest' },
  { id: 'focus-order', match: /\bfocus\s+order\b|\btab\s+order\b|\breading\s+order\b|\blogical\s+order\b/i, source: 'manifest' },
  { id: 'keyboard-operation', match: /\bkeyboard\s+operation\b|\bkeyboard\s+reachable\b|\bkeyboard\s+control\b|\boperable\s+via\s+keyboard\b/i, source: 'manifest' },
  { id: 'semantic-naming', match: /\bsemantic\s+naming\b|\baccessible\s+name\b|\baria-label\b|\blabelled\s+control\b/i, source: 'manifest' },
  { id: 'semantic-state', match: /\bsemantic\s+state\b|\baria-pressed\b|\baria-expanded\b|\baria-selected\b|\baria-disabled\b/i, source: 'manifest' },
  { id: 'reduced-motion', match: /\breduced\s+motion\b|\bprefers-reduced-motion\b|\bvestibular\s+safe\b|\bcalmer\s+motion\b/i, source: 'manifest' },
  { id: 'music-rhythm', match: /\b(?:music|sound|audio|strudel|tone|bpm|tempo|groove|drum|percussion)\b[\s\S]*\b(?:rhythm|beat|pulse|pattern|timing)\b|\b(?:rhythm|beat|pulse|pattern|timing)\b[\s\S]*\b(?:music|sound|audio|strudel|tone|bpm|tempo|groove|drum|percussion)\b/i, source: 'manifest' },
  { id: 'music-harmony', match: /\b(?:music|sound|audio)\b[\s\S]*\b(?:melody|chord|harmony|key|scale|voicing|arpeggio)\b|\b(?:melody|chord|voicing|arpeggio)\b/i, source: 'manifest' },
  { id: 'music-dynamics', match: /\b(?:music|sound|audio)\b[\s\S]*\b(?:dynamics|envelope|adsr|velocity|accent|amplitude)\b|\b(?:dynamics|envelope|adsr|velocity|accent|amplitude)\b/i, source: 'manifest' },
  { id: 'music-timbre', match: /\b(?:music|sound|audio)\b[\s\S]*\b(?:timbre|synth|synthesis|oscillator|waveform|spectral)\b|\b(?:timbre|synth|synthesis|oscillator|waveform|spectral)\b/i, source: 'manifest' },
  { id: 'focal-point', match: /\bfocal\s+point\b|\bcenter\s+of\s+interest\b|\bprimary\s+subject\b|\bfocal\b/i, source: 'manifest' },
  { id: 'negative-space', match: /\bnegative\s+space\b|\bbreathing\s+room\b|\bquiet\s+field\b|\bsilence\b|\bstillness\b/i, source: 'manifest' },
  { id: 'color-harmony', match: /\bcolor\s+harmony\b|\bharmonious\b|\bpalette\b/i, source: 'manifest' },
  { id: 'rhythm', match: /\brhythm\b|\bbeat\b|\bpulse\b|\balternation\b|\btemporal\s+pattern\b|\bcadence\b/i, source: 'manifest' },
  { id: 'contrast', match: /\bcontrast\b|\bjuxtaposition\b|\bdifference\b|\bseparation\b|\bopposition\b|\brelease\b/i, source: 'manifest' },
];

function selectContractForRuleId(id: string): CreativePrincipleContract | undefined {
  const manifest = CREATIVE_PRINCIPLE_MANIFEST.contracts[id];
  if (manifest) return manifest;
  const motionId = id as keyof typeof MOTION_TEMPORAL_CONTRACTS;
  return MOTION_TEMPORAL_CONTRACTS[motionId];
}

function briefText(brief: string): string {
  const value = brief.trim().replace(/\s+/g, ' ');
  if (!value) throw new Error('Creative brief must be a non-empty ordinary-language brief');
  if (/\b(?:for example|e\.g\.|for instance|such as)\b/i.test(value)) throw new Error('Creative brief must be example-free');
  return value;
}

function requestedPrinciples(brief: string, explicit: readonly string[] | undefined): string[] {
  const values = explicit ? [...explicit] : [];
  const hasRequestVerb = /\b(?:use|using|apply|applies|select|selected)\b/i.test(brief);
  const normalizedBrief = ` ${normalized(brief)} `;
  const hasMusicRow = MUSIC_SOUND_DISPOSITION_MATRIX.some((entry) => normalizedBrief.includes(` ${normalized(entry.row.name)} `));
  if (hasRequestVerb || hasMusicRow) {
    for (const term of UNSUPPORTED_TERMS) {
      const words = term.split(/\s+/);
      const allPresent = words.every((word) => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}`, 'i').test(brief);
      });
      if (allPresent) values.push(term);
    }
    // 1. Historical/unsupported color/composition and music rows flow into the unsupported list.
    const matchedRows = [...COLOR_COMPOSITION_DISPOSITION_MATRIX, ...MUSIC_SOUND_DISPOSITION_MATRIX]
      .filter((entry) => entry.disposition === 'unsupported'
        && (entry.row.source === MUSIC_SOUND_MANIFEST_SCHEMA || hasRequestVerb)
        && normalizedBrief.includes(` ${normalized(entry.row.name)} `))
      .sort((left, right) => normalized(right.row.name).length - normalized(left.row.name).length);
    for (const entry of matchedRows) {
      const name = normalized(entry.row.name);
      const shadowedByLongerMatch = matchedRows.some((candidate) => {
        const candidateName = normalized(candidate.row.name);
        return candidateName.length > name.length && ` ${candidateName} `.includes(` ${name} `);
      });
      if (!shadowedByLongerMatch) values.push(entry.row.name);
    }
    // 2. Historical / unsupported interaction/a11y rows flow into the unsupported list.
    //    Supported rows (keyboard-operation, focus-visibility, ...) resolve through
    //    resolveCreativePrinciple in compileCreativeThesis, so they never enter the
    //    unsupported path and remain reachable as `selected` contracts.
    const matchedInteractionA11y = INTERACTION_A11Y_DISPOSITION_MATRIX
      .filter((entry) => entry.disposition !== 'supported' && normalizedBrief.includes(` ${normalized(entry.row.name)} `))
      .sort((left, right) => normalized(right.row.name).length - normalized(left.row.name).length);
    for (const entry of matchedInteractionA11y) {
      const name = normalized(entry.row.name);
      const shadowedByLongerMatch = matchedInteractionA11y.some((candidate) => {
        const candidateName = normalized(candidate.row.name);
        return candidateName.length > name.length && ` ${candidateName} `.includes(` ${name} `);
      });
      if (!shadowedByLongerMatch) values.push(entry.row.name);
    }
  }
  return [...new Set(values.map(normalized))];
}

function applicabilityReason(brief: string, contract: CreativePrincipleContract): string {
  const lower = brief.toLowerCase();
  if (/quiet|restraint|luminous|release|threshold|focus|focal|legible/.test(lower)) return contract.positiveApplicability[1];
  return contract.positiveApplicability[0];
}

function formTypographyPlan(brief: string): CreativeFormTypographyPlan {
  const lower = brief.toLowerCase();
  const selectedRows = FORM_TYPOGRAPHY_ROWS.filter((row) => row.disposition === 'supported' && (
    (row.id === 'form-visual-hierarchy' && /focal|focus|hierarchy|legible/.test(lower))
    || (row.id === 'typography-hierarchy' && /typograph|text|letter/.test(lower))
    || (row.id === 'typography-spacing' && /typograph|text|spacing|leading|tracking/.test(lower))
    || (row.id === 'form-negative-space' && /negative space|breathing room|quiet field/.test(lower))
    || (row.id === 'form-contrast' && /contrast|difference|opposition/.test(lower))
  ));
  const rows = selectedRows.length > 0 ? selectedRows : [FORM_TYPOGRAPHY_ROWS[0]];
  const selected = rows.map((row) => ({ rowId: row.id, sourceLocator: row.sourceLocator, rationale: row.rationale, evidenceIds: row.perceptualEvidence.map((item) => item.id) }));
  const declaredTargets = rows.flatMap((row) => row.perceptualEvidence.map((item) => ({ rowId: row.id, metric: item.metric, target: item.target })));
  const excludedRows = FORM_TYPOGRAPHY_ROWS.filter((row): row is FormTypographyRow & { readonly disposition: 'historical' | 'unsupported' } => row.disposition !== 'supported');
  const excluded = excludedRows.map((row) => ({ rowId: row.id, disposition: row.disposition, reason: row.rationale }));
  return deepFreeze({
    selected,
    rationale: `Selected ${rows.map((row) => row.label.toLowerCase()).join(', ')} because the ordinary-language brief requires a readable focal relationship.`,
    declaredTargets,
    boundedRevision: {
      maxAttempts: 1,
      operator: 'one render-gate blend remediation',
      // Honest trigger: the gate measures WHOLE-FRAME luminance, not the
      // per-row form/typography targets above. Declared targets are not
      // measured at runtime.
      trigger: 'render-gate whole-frame luminance verdict is washed-out, crushed, or muddy',
    },
    excluded,
  });
}

export interface CompileCreativeThesisOptions {
  readonly requestedPrinciples?: readonly string[];
}

export interface PrincipleSelection {
  readonly contract: CreativePrincipleContract;
  readonly disposition: ThesisPrincipleDisposition;
  readonly applicabilityReason: string;
  readonly projectionDigest: string;
}

function unsupportedPrincipleReason(name: string): string {
  const key = rowKey(name);
  const interaction = INTERACTION_A11Y_DISPOSITION_MATRIX.find((entry) => rowKey(entry.row.name) === key);
  if (interaction?.reason) {
    return `${interaction.disposition === 'historical' ? '[historical] ' : ''}${interaction.reason}`;
  }
  const music = MUSIC_SOUND_DISPOSITION_MATRIX.find((entry) => normalized(entry.row.name) === normalized(name));
  if (music?.reason) return music.reason;
  const disposition = principleDispositionFor(name);
  return disposition.disposition === 'unsupported' && disposition.reason
    ? disposition.reason
    : 'No canonical contract is available for this principle in the frozen manifest.';
}

export function selectPrincipleForBrief(brief: string, requested: readonly string[]): { selection?: PrincipleSelection; unsupported: { requested: string; reason: string }[] } {
  if (requested.length > 0) {
    const unsupportedEntries = requested
      .map((name) => normalized(name))
      .filter((name) => !resolveCreativePrinciple(name))
      .map((name) => ({ requested: name, reason: unsupportedPrincipleReason(name) }));
    if (unsupportedEntries.length > 0) return { unsupported: unsupportedEntries };
    const explicit = resolveCreativePrinciple(requested[0]!);
    if (explicit) {
      const projectionDigest = digest(projectCreativePrinciple(explicit));
      return {
        selection: {
          contract: explicit,
          disposition: 'selected',
          applicabilityReason: applicabilityReason(brief, explicit),
          projectionDigest,
        },
        unsupported: [],
      };
    }
  }
  const matchedRule = PRINCIPLE_SELECTION_RULES.find((rule) => rule.match.test(brief));
  const contract = matchedRule ? selectContractForRuleId(matchedRule.id) : undefined;
  const chosen = contract ?? CREATIVE_PRINCIPLE_MANIFEST.contracts.contrast;
  const projectionDigest = digest(projectCreativePrinciple(chosen));
  const isSelected = matchedRule?.id === chosen.identity.id;
  const disposition: ThesisPrincipleDisposition = isSelected ? 'selected' : 'relevant';
  return { selection: { contract: chosen, disposition, applicabilityReason: applicabilityReason(brief, chosen), projectionDigest }, unsupported: [] };
}

export function buildThesisFor(brief: string, selection: PrincipleSelection, unsupported: { requested: string; reason: string }[]): CreativeThesis {
  const contract = selection.contract;
  const isUnsupported = unsupported.length > 0;
  const arcByDomain: Record<string, readonly string[]> = {
    motion: ['Open with the first samples establishing the field.', 'Progress through the declared development samples.', 'Close with the declared release samples.'],
  };
  const perceptualEmotionalArc = arcByDomain[contract.domain.domain] ?? ['Begin with a restrained perceptual field.', 'Make the chosen difference increasingly legible.', 'Resolve with a release that preserves the focal relationship.'];
  const principle: CreativeThesisPrinciple = {
    principleId: contract.identity.id,
    disposition: selection.disposition,
    applicabilityReason: selection.applicabilityReason,
    contractIdentity: { principleId: contract.identity.id, contractVersion: contract.schemaVersion, projectionDigest: selection.projectionDigest },
  };
  const principles: CreativeThesisPrinciple[] = isUnsupported
    ? unsupported.map((item) => ({
        principleId: item.requested,
        disposition: 'unsupported',
        applicabilityReason: item.reason,
        contractIdentity: { principleId: item.requested, contractVersion: 0, projectionDigest: '' },
      }))
    : [principle];
  // Unsupported theses carry no citations: the chosen contract is a placeholder
  // for the unsupported disposition and is not the canonical source of truth.
  // Supported theses cite every provenance source on the chosen contract.
  const citations: CreativeThesisCitation[] = isUnsupported
    ? []
    : contract.provenance.sources.map((source) => ({ principleId: contract.identity.id, contractVersion: contract.schemaVersion, sourceId: source.id, locator: source.locator }));
  const thesisSeed = `${brief.toLowerCase()}|${contract.identity.id}|${selection.projectionDigest}|${unsupported.map((item) => item.requested).join(',')}`;
  return deepFreeze({
    schema: CREATIVE_THESIS_SCHEMA,
    schemaVersion: CREATIVE_THESIS_VERSION,
    thesisId: `thesis-${digest(thesisSeed).slice(0, 24)}`,
    briefDigest: digest(brief),
    disposition: isUnsupported ? 'unsupported' : 'supported',
    exampleFree: true,
    intendedExperienceMeaning: brief,
    perceptualEmotionalArc,
    principles,
    tensions: contract.conflictingPrinciples.length > 0 ? [`Clarity may compete with ambiguity; avoid mixing with ${contract.conflictingPrinciples.join(', ')} when meaning depends on a single declared signal.`] : ['Clarity may compete with ambiguity; keep the chosen signal legible when meaning depends on it.'],
    uncertaintiesAssumptions: ['The brief leaves medium, palette, and exact execution open.', 'The audience should perceive the chosen signal without requiring explanation.'],
    nonGoals: ['Copying a named artwork or style.', 'Treating a principle as a fixed execution recipe.'],
    hardFloors: contract.observablePerceptualEvidence.map((item) => item.description),
    openCreativeDimensions: ['medium', 'palette', 'scale', 'density', 'tempo', 'duration'],
    candidateSuccessEvidence: contract.observablePerceptualEvidence.map((item) => item.description),
    excludedAlternatives: contract.conflictingPrinciples.length > 0 ? [`A treatment dominated by ${contract.conflictingPrinciples.join(' or ')} that erases the intended signal.`] : ['A treatment that erases the intended signal.'],
    citations,
    unsupported,
    formTypography: formTypographyPlan(brief),
  });
}

export function compileCreativeThesis(ordinaryLanguageBrief: string, options: CompileCreativeThesisOptions = {}): CreativeThesis {
  const brief = briefText(ordinaryLanguageBrief);
  const requested = requestedPrinciples(brief, options.requestedPrinciples);
  const { selection, unsupported } = selectPrincipleForBrief(brief, requested);
  if (!selection) {
    return buildThesisFor(brief, {
      contract: CREATIVE_PRINCIPLE_MANIFEST.contracts.contrast,
      disposition: 'unsupported',
      applicabilityReason: unsupported[0]?.reason ?? 'No canonical contract is available.',
      projectionDigest: '',
    }, unsupported);
  }
  return buildThesisFor(brief, selection, unsupported);
}

const THESIS_FIELDS = ['schema', 'schemaVersion', 'thesisId', 'briefDigest', 'disposition', 'exampleFree', 'intendedExperienceMeaning', 'perceptualEmotionalArc', 'principles', 'tensions', 'uncertaintiesAssumptions', 'nonGoals', 'hardFloors', 'openCreativeDimensions', 'candidateSuccessEvidence', 'excludedAlternatives', 'citations', 'unsupported', 'formTypography'];

function requireNonEmptyStringArray(value: unknown, path: string, allowEmpty = false): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`Creative Thesis has invalid ${path}`);
}

function requireThesisShape(value: Record<string, unknown>): void {
  // `formTypography` is optional for backward compatibility with prior-v1
  // theses; `migrateCreativeThesis` fills it before shape validation runs.
  const requiredFields = THESIS_FIELDS.filter((field) => field !== 'formTypography');
  const missing = requiredFields.find((field) => !(field in value));
  if (missing) throw new Error(`Creative Thesis missing ${missing}`);
  const allowedFields = THESIS_FIELDS;
  if (Object.keys(value).some((field) => !allowedFields.includes(field))) throw new Error('Creative Thesis has an unsupported field');
  for (const field of ['thesisId', 'briefDigest', 'intendedExperienceMeaning']) if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`Creative Thesis has invalid ${field}`);
  if (value.exampleFree !== true) throw new Error('Creative Thesis must be example-free');
  if (value.disposition !== 'supported' && value.disposition !== 'unsupported') throw new Error('Creative Thesis has an invalid disposition');
  for (const field of ['perceptualEmotionalArc', 'tensions', 'uncertaintiesAssumptions', 'nonGoals', 'hardFloors', 'openCreativeDimensions', 'candidateSuccessEvidence', 'excludedAlternatives']) requireNonEmptyStringArray(value[field], field);
  if (!Array.isArray(value.principles) || !Array.isArray(value.citations) || !Array.isArray(value.unsupported)) throw new Error('Creative Thesis has invalid collections');
}

function validateFormTypographyPlan(value: unknown): CreativeFormTypographyPlan {
  if (!isObject(value) || !Array.isArray(value.selected) || typeof value.rationale !== 'string' || !value.rationale.trim() || !Array.isArray(value.declaredTargets) || !Array.isArray(value.excluded) || !isObject(value.boundedRevision)) throw new Error('Creative Thesis has an invalid form/typography plan');
  validateFormTypographyManifest(FORM_TYPOGRAPHY_ROWS);
  const rows = new Map(FORM_TYPOGRAPHY_ROWS.map((row) => [row.id, row]));
  for (const selected of value.selected) {
    if (!isObject(selected) || typeof selected.rowId !== 'string' || !isObject(rows.get(selected.rowId)) || rows.get(selected.rowId)?.disposition !== 'supported' || selected.sourceLocator !== rows.get(selected.rowId)?.sourceLocator || typeof selected.rationale !== 'string' || !Array.isArray(selected.evidenceIds)) throw new Error('Creative Thesis selected an invalid form/typography row');
  }
  for (const excluded of value.excluded) {
    if (!isObject(excluded) || typeof excluded.rowId !== 'string' || !isObject(rows.get(excluded.rowId)) || rows.get(excluded.rowId)?.disposition === 'supported' || !['historical', 'unsupported'].includes(String(excluded.disposition)) || typeof excluded.reason !== 'string' || !excluded.reason.trim()) throw new Error('Creative Thesis entered a non-runtime form/typography row');
  }
  if (value.boundedRevision.maxAttempts !== 1 || typeof value.boundedRevision.operator !== 'string' || typeof value.boundedRevision.trigger !== 'string') throw new Error('Creative Thesis has an unbounded form/typography revision');
  return value as unknown as CreativeFormTypographyPlan;
}

/** Prior-v1 compatibility: a thesis persisted before `formTypography` existed
 *  is migrated to the canonical current shape by computing the plan from its
 *  brief, exactly as `compileCreativeThesis` would. The migration is a no-op
 *  for theses that already carry a plan. */
function migrateCreativeThesis(value: Record<string, unknown>): Record<string, unknown> {
  if (value.formTypography !== undefined) return value;
  if (typeof value.intendedExperienceMeaning !== 'string' || !value.intendedExperienceMeaning.trim()) return value;
  return { ...value, formTypography: formTypographyPlan(value.intendedExperienceMeaning) };
}

export function validateCreativeThesis(value: unknown): CreativeThesis {
  if (!isObject(value)) throw new Error('Creative Thesis must be an object');
  if (value.schema !== CREATIVE_THESIS_SCHEMA || value.schemaVersion !== CREATIVE_THESIS_VERSION) throw new Error('Creative Thesis has an invalid schema');
  // Prior-v1 compatibility: synthesize formTypography from the brief if the
  // input predates the field. After migration the canonical comparison below
  // sees the same shape a freshly compiled thesis would produce.
  const migrated = migrateCreativeThesis(value);
  requireThesisShape(migrated);
  validateFormTypographyPlan(migrated.formTypography);
  const principles = migrated.principles as unknown[];
  const citations = migrated.citations as unknown[];
  const unsupported = migrated.unsupported as unknown[];
  for (const item of principles) {
    if (!isObject(item) || typeof item.principleId !== 'string' || !item.principleId.trim() || !isObject(item.contractIdentity) || !isObject(item)) throw new Error('Creative Thesis has an invalid principle identity');
    if (!['selected', 'relevant', 'unsupported'].includes(String(item.disposition)) || typeof item.applicabilityReason !== 'string' || !item.applicabilityReason.trim()) throw new Error('Creative Thesis has an invalid principle disposition');
    const identity = item.contractIdentity;
    if (typeof identity.principleId !== 'string' || typeof identity.contractVersion !== 'number' || typeof identity.projectionDigest !== 'string') throw new Error('Creative Thesis has an invalid contract identity');
  }
  for (const item of citations) if (!isObject(item) || typeof item.principleId !== 'string' || typeof item.sourceId !== 'string' || typeof item.locator !== 'string' || typeof item.contractVersion !== 'number') throw new Error('Creative Thesis has an invalid citation');
  for (const item of unsupported) if (!isObject(item) || typeof item.requested !== 'string' || !item.requested.trim() || typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Creative Thesis has an invalid unsupported record');
  if (migrated.disposition === 'supported' && (principles.length === 0 || unsupported.length > 0 || citations.length === 0)) throw new Error('Creative Thesis has an invalid supported disposition');
  if (migrated.disposition === 'unsupported' && (unsupported.length === 0 || citations.length > 0)) throw new Error('Creative Thesis has an invalid unsupported disposition');
  const selected = principles.find((item) => isObject(item) && item.disposition === 'selected');
  const requestedPrinciples = [
    ...(selected && isObject(selected) ? [String(selected.principleId)] : []),
    ...unsupported.map((item) => String((item as Record<string, unknown>).requested)),
  ];
  const expected = compileCreativeThesis(migrated.intendedExperienceMeaning as string, { requestedPrinciples });
  if (!isDeepStrictEqual(migrated, expected)) throw new Error('Creative Thesis does not match canonical compilation');
  return migrated as unknown as CreativeThesis;
}

export function creativeThesisIdentity(thesis: CreativeThesis): CreativeThesisIdentity {
  const validated = validateCreativeThesis(thesis);
  if (validated.disposition !== 'supported') throw new Error('Creative Thesis is unsupported and has no execution identity');
  const principle = validated.principles.find((item) => item.disposition !== 'unsupported');
  if (!principle) throw new Error('Creative Thesis has no supported principle');
  return { thesisId: validated.thesisId, principleId: principle.contractIdentity.principleId, contractVersion: principle.contractIdentity.contractVersion, projectionDigest: principle.contractIdentity.projectionDigest };
}

function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Place provenance/evidence <meta> tags validly inside the document.
 *  Handles full documents (with/without <head>), DOCTYPE-only documents,
 *  body-only fragments, and pure fragments — never prepending before a
 *  DOCTYPE (which would produce invalid HTML). Non-mutating: no <style>,
 *  no global CSS that could alter generated artwork. */
function placeHeadMetas(html: string, metas: string): string {
  // 1. Existing <head>: inject metas immediately after the opening tag.
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}${metas}`);
  }
  // 2. No <head> but an <html> root: synthesize a <head> right after <html>.
  if (/<html(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (tag) => `${tag}<head>${metas}</head>`);
  }
  // 3. DOCTYPE present without <html>/<head>: complete the document structure.
  const doctypeMatch = html.match(/<!DOCTYPE[^>]*>\s*/i);
  if (doctypeMatch && doctypeMatch.index !== undefined) {
    const end = doctypeMatch.index + doctypeMatch[0].length;
    const content = html.slice(end);
    const body = /<body(?:\s[^>]*)?>/i.test(content) ? content : `<body>${content}</body>`;
    return `${html.slice(0, end)}<html><head>${metas}</head>${body}</html>`;
  }
  // 4. Body-only input: complete it with an html root and a valid head.
  if (/<body(?:\s[^>]*)?>/i.test(html)) {
    return `<html><head>${metas}</head>${html}</html>`;
  }
  // 5. Pure fragment: promote it to a valid minimal document.
  return `<!DOCTYPE html><html><head>${metas}</head><body>${html}</body></html>`;
}

export function embedCreativeThesisIdentity(html: string, thesis: CreativeThesis): string {
  const validated = validateCreativeThesis(thesis);
  const identity = creativeThesisIdentity(validated);
  const attrs = `data-creative-thesis-id="${htmlAttribute(identity.thesisId)}" data-creative-principle-id="${htmlAttribute(identity.principleId)}" data-creative-contract-version="${identity.contractVersion}" data-creative-projection-digest="${htmlAttribute(identity.projectionDigest)}"`;
  // `validateCreativeThesis` migrates prior-v1 theses, so the plan is present here.
  const plan = validated.formTypography!;
  const rowIds = plan.selected.map((row) => row.rowId).join(',');
  const provenance = plan.selected.map((row) => `${row.rowId}=${row.sourceLocator}`).join(' | ');
  const declaredTargets = plan.declaredTargets.map((item) => `${item.metric}: ${item.target}`).join(' | ');
  const excluded = plan.excluded.map((row) => `${row.rowId}=${row.disposition}`).join(' | ');
  const metas = `<meta name="sinter-creative-thesis-id" content="${htmlAttribute(identity.thesisId)}"><meta name="sinter-creative-principle-id" content="${htmlAttribute(identity.principleId)}"><meta name="sinter-creative-contract-version" content="${identity.contractVersion}"><meta name="sinter-creative-projection-digest" content="${htmlAttribute(identity.projectionDigest)}"><meta name="sinter-form-typography-rows" content="${htmlAttribute(rowIds)}"><meta name="sinter-form-typography-provenance" content="${htmlAttribute(provenance)}"><meta name="sinter-form-typography-excluded" content="${htmlAttribute(excluded)}"><meta name="sinter-form-typography-rationale" content="${htmlAttribute(plan.rationale)}"><meta name="sinter-form-typography-declared-targets" content="${htmlAttribute(declaredTargets)}"><meta name="sinter-form-typography-revision-max" content="1">`;
  const embedded = placeHeadMetas(html, metas);
  if (/<body(?:\s[^>]*)?>/i.test(embedded)) return embedded.replace(/<body(\s[^>]*)?>/i, (tag) => tag.replace(/>$/, ` ${attrs}>`));
  if (/<html(?:\s[^>]*)?>/i.test(embedded)) return embedded.replace(/<html(\s[^>]*)?>/i, (tag) => tag.replace(/>$/, ` ${attrs}>`));
  return `<div hidden ${attrs}></div>${embedded}`;
}

export function creativeThesisPromptContext(thesis: CreativeThesis): string {
  const validated = validateCreativeThesis(thesis);
  if (validated.disposition !== 'supported') throw new Error('Creative Thesis is unsupported and cannot govern generation');
  const principle = validated.principles.find((item) => item.disposition !== 'unsupported');
  if (!principle) throw new Error('Creative Thesis has no supported principle');
  const plan = validated.formTypography!;
  return [
    'CANONICAL CREATIVE INTELLIGENCE CONTRACT (do not detach from this request):',
    `thesisId=${validated.thesisId}`,
    `principleId=${principle.contractIdentity.principleId}`,
    `contractVersion=${principle.contractIdentity.contractVersion}`,
    `projectionDigest=${principle.contractIdentity.projectionDigest}`,
    `hardFloors=${validated.hardFloors.join(' | ')}`,
    `successEvidence=${validated.candidateSuccessEvidence.join(' | ')}`,
    `formTypographyRows=${plan.selected.map((row) => row.rowId).join(',')}`,
    `formTypographyProvenance=${plan.selected.map((row) => `${row.rowId}=${row.sourceLocator}`).join(' | ')}`,
    `formTypographyRationale=${plan.rationale}`,
    // Honest labeling: these are DECLARED design targets, not runtime measurements.
    // Whole-frame render-gate evidence (when collected) is reported out-of-band
    // by CompositionOrchestrator.creativeEvidence.gateEvidence.
    `formTypographyDeclaredTargets=${plan.declaredTargets.map((item) => `${item.metric}: ${item.target}`).join(' | ')}`,
    `formTypographyRendering=${plan.selected.map((selected) => `${selected.rowId}: ${FORM_TYPOGRAPHY_ROWS.find((row) => row.id === selected.rowId)?.rendering.instruction ?? ''}`).join(' | ')}`,
    `formTypographyRevisionMax=${plan.boundedRevision.maxAttempts}`,
  ].join('\n');
}
