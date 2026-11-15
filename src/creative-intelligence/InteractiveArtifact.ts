import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  CREATIVE_PRINCIPLE_MANIFEST,
  CreativeThesis,
  CREATIVE_THESIS_SCHEMA,
  CREATIVE_THESIS_VERSION,
  compileCreativeThesis,
  resolveCreativePrinciple,
  validateCreativeThesis,
} from './CreativeIntelligence.js';

/**
 * W8-09 interaction / accessibility artifacts.
 *
 * A deterministic, no-spend HTML artifact builder. The artifact binds the
 * exact thesis identity, selected principle IDs, input event, prior state,
 * next state, runtime identity, and bounded revision count into a single
 * identity record. Browser execution is forbidden by the W8-09 brief — all
 * verification is done via deterministic HTML parsing of the emitted string.
 */

export const INTERACTIVE_ARTIFACT_SCHEMA = 'sinter.interactive-artifact' as const;
export const INTERACTIVE_ARTIFACT_VERSION = 1 as const;

/**
 * Hard-coded maximum number of bounded attribution revisions. Aesthetic
 * scoring cannot waive this bound; the brief makes one revision attributable,
 * never more.
 */
export const BOUNDED_REVISION_MAX = 1 as const;

export interface InteractiveArtifactIdentity {
  /** SHA-256 digest of the rendered artifact body. */
  readonly artifactDigest: string;
  /** Thesis identity fields bound verbatim from the chosen Creative Thesis. */
  readonly thesisId: string;
  readonly principleIds: readonly string[];
  /** Stable runtime identity: which procedural epoch generated the artifact. */
  readonly runtimeId: string;
  /** Number of bounded attribution revisions applied so far. */
  readonly revisionsApplied: number;
}

export interface InteractiveArtifactTraceStep {
  /** Stable input event symbol (e.g. "key:Enter", "key:Tab", "key:Escape"). */
  readonly input: string;
  /** State before the input was applied. */
  readonly priorState: string;
  /** State after the input was applied. */
  readonly nextState: string;
}

export interface InteractiveArtifactTrace {
  readonly identity: InteractiveArtifactIdentity;
  readonly steps: readonly InteractiveArtifactTraceStep[];
}

export type InteractiveArtifactAction = 'primary' | 'secondary' | 'escape' | 'reduce-motion';

export function transitionInteractiveArtifactState(state: string, action: InteractiveArtifactAction): string {
  if (action === 'primary') return state === 'primary-activated' ? 'rest' : 'primary-activated';
  if (action === 'secondary') return state === 'toggle-pressed' ? 'rest' : 'toggle-pressed';
  if (action === 'reduce-motion') return 'reduced-variant';
  return 'rest';
}

export interface BuildInteractiveArtifactOptions {
  /** Specified request key for the artifact instance — used inside the runtime identity. */
  readonly runtimeSeed: string;
  /** Number of bounded revisions (0..BOUNDED_REVISION_MAX). Defaults to 0. */
  readonly revisionsApplied?: number;
  /**
   * Explicit selection of W8-09 principle IDs to bind into the artifact
   * identity, in addition to the thesis's selected principle. Every entry
   * must be a supported contract id in the CreativeIntelligence manifest;
   * unknown ids are silently dropped to keep the artifact identity honest.
   */
  readonly selectedPrincipleIds?: readonly string[];
}

/**
 * Build a deterministic, no-spend interactive HTML artifact. The artifact is
 * driven entirely from the supplied Creative Thesis and the bounded-revision
 * counter; it does not launch a browser, run an LLM, or perform any network
 * I/O.
 *
 * Returned identity covers:
 *  - exact artifact digest (sha256 over the rendered body, excluding the
 *    artifact-id meta tag),
 *  - exact thesis identity (thesisId + selected principleIds),
 *  - exact bounded-revision count (must remain <= BOUNDED_REVISION_MAX).
 */
export function buildInteractiveArtifact(thesis: CreativeThesis, options: BuildInteractiveArtifactOptions): {
  readonly html: string;
  readonly trace: InteractiveArtifactTrace;
} {
  const validated = validateCreativeThesis(thesis);
  if (validated.disposition !== 'supported') {
    throw new Error('Interactive artifact requires a supported Creative Thesis');
  }
  const revisions = options.revisionsApplied ?? 0;
  if (!Number.isInteger(revisions) || revisions < 0) {
    throw new Error(`Interactive artifact revisionsApplied must be a non-negative integer (got ${String(options.revisionsApplied)})`);
  }
  if (revisions > BOUNDED_REVISION_MAX) {
    throw new Error(`Interactive artifact exceeds bounded revision maximum (${BOUNDED_REVISION_MAX})`);
  }

  const principleIdsFromThesis = validated.principles
    .filter((principle) => principle.disposition === 'selected')
    .map((principle) => principle.principleId);

  // Explicit selections merge with the thesis selection. De-duplicate while
  // preserving order: explicit selections first, then thesis-derived ones.
  const explicit = (options.selectedPrincipleIds ?? [])
    .filter((id): id is string => typeof id === 'string')
    .filter((id) => CREATIVE_PRINCIPLE_MANIFEST.contracts[id] !== undefined);
  const seenIds = new Set<string>();
  const principleIds: string[] = [];
  for (const id of [...explicit, ...principleIdsFromThesis]) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      principleIds.push(id);
    }
  }
  if (principleIds.length === 0) principleIds.push(validated.principles[0].principleId);

  const supportsReducedMotion = principleIds.includes('reduced-motion');

  // Exercise the same reducer encoded into the emitted event handlers. This is
  // executable behavior evidence, not a separately invented trace vocabulary.
  const baseState = 'rest';
  const steps: InteractiveArtifactTraceStep[] = [];
  let currentState = baseState;
  const exercise = (input: string, action: InteractiveArtifactAction): void => {
    const nextState = transitionInteractiveArtifactState(currentState, action);
    steps.push({ input, priorState: currentState, nextState });
    currentState = nextState;
  };
  exercise('primary.click', 'primary');
  exercise('secondary.click', 'secondary');
  exercise('document.keydown:Escape', 'escape');
  if (supportsReducedMotion) {
    exercise('media.prefers-reduced-motion:change', 'reduce-motion');
  }

  const principleListAttr = principleIds.join(',');

  const html = renderInteractiveArtifactHtml({
    thesis: validated,
    principleIds,
    principleListAttr,
    supportsReducedMotion,
    finalState: currentState,
    runtimeSeed: options.runtimeSeed,
    revisionsApplied: revisions,
  });

  const unsignedBody = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="sinter-creative-thesis-id" content="${htmlEscape(validated.thesisId)}">
<meta name="sinter-creative-principle-id" content="${htmlEscape(principleIds[0] ?? 'unbound')}">
<meta name="sinter-creative-contract-version" content="${validated.principles[0]?.contractIdentity.contractVersion ?? 0}">
<meta name="sinter-creative-projection-digest" content="${htmlEscape(validated.principles[0]?.contractIdentity.projectionDigest ?? '')}">
<meta name="sinter-creative-thesis-schema" content="${CREATIVE_THESIS_SCHEMA}">
<meta name="sinter-creative-thesis-version" content="${CREATIVE_THESIS_VERSION}">
<meta name="sinter-interactive-artifact-schema" content="${INTERACTIVE_ARTIFACT_SCHEMA}">
<meta name="sinter-interactive-artifact-version" content="${INTERACTIVE_ARTIFACT_VERSION}">
<meta name="sinter-interactive-artifact-digest" content="">
<meta name="sinter-interactive-artifact-principle-ids" content="${htmlEscape(principleListAttr)}">
<meta name="sinter-interactive-artifact-runtime" content="${htmlEscape(options.runtimeSeed)}">
<meta name="sinter-interactive-artifact-revisions" content="${String(revisions)}">
<meta name="sinter-interactive-artifact-bounded-revision-max" content="${String(BOUNDED_REVISION_MAX)}">
<title>Sinter W8-09 interactive evidence</title>
<style>
  :focus { outline: 3px solid hsl(210 80% 50%); outline-offset: 2px; }
  button { font: inherit; padding: 0.5rem 1rem; margin: 0.25rem; border-radius: 0.25rem; border: 1px solid currentColor; background: transparent; color: inherit; }
  @media (prefers-reduced-motion: reduce) {
    .motion { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
${html}
</body>
</html>`;
  const artifactDigest = digestCanonicalArtifact(unsignedBody);
  const body = unsignedBody.replace(
    'name="sinter-interactive-artifact-digest" content=""',
    `name="sinter-interactive-artifact-digest" content="${artifactDigest}"`,
  );

  const identity: InteractiveArtifactIdentity = {
    artifactDigest,
    thesisId: validated.thesisId,
    principleIds: [...principleIds],
    runtimeId: `runtime-${options.runtimeSeed}`,
    revisionsApplied: revisions,
  };

  return {
    html: body,
    trace: {
      identity,
      steps,
    },
  };
}

interface RenderInputs {
  readonly thesis: CreativeThesis;
  readonly principleIds: readonly string[];
  readonly principleListAttr: string;
  readonly supportsReducedMotion: boolean;
  readonly finalState: string;
  readonly runtimeSeed: string;
  readonly revisionsApplied: number;
}

function renderInteractiveArtifactHtml(inputs: RenderInputs): string {
  const { thesis, principleIds, principleListAttr, supportsReducedMotion, finalState, runtimeSeed, revisionsApplied } = inputs;
  const buttonAttrs = [
    'type="button"',
    'aria-label="Activate primary subject"',
    'aria-pressed="false"',
    'data-control="primary"',
  ].filter(Boolean).join(' ');
  const toggleAttrs = [
    'type="button"',
    'aria-label="Toggle secondary control"',
    'aria-pressed="false"',
    'data-control="secondary"',
  ].filter(Boolean).join(' ');
  return `
<main data-sinter-creative-thesis-id="${htmlEscape(thesis.thesisId)}"
      data-creative-principle-id="${htmlEscape(principleIds[0] ?? 'unbound')}"
      data-sinter-interactive-state="${htmlEscape(finalState)}"
      data-sinter-interactive-principles="${htmlEscape(principleListAttr)}"
      data-sinter-runtime="${htmlEscape(runtimeSeed)}">
  <h1>Sinter W8-09 interactive evidence</h1>
  <p data-sinter-intent>${htmlEscape(thesis.intendedExperienceMeaning)}</p>
  <button ${buttonAttrs}>Primary action</button>
  <button ${toggleAttrs}>Toggle</button>
  <p class="motion" data-sinter-state>Current state: <span data-sinter-state-value>${htmlEscape(finalState)}</span></p>
  <p data-sinter-principle-list aria-label="Selected principle IDs">${htmlEscape(principleListAttr)}</p>
  <p data-sinter-revision data-sinter-revision-max="${BOUNDED_REVISION_MAX}" data-revision-treatment="${revisionsApplied === 1 ? 'clarified-state-feedback' : 'baseline'}"${supportsReducedMotion ? ' data-reduced-motion="true"' : ''}>Bounded revisions applied: ${revisionsApplied} / ${BOUNDED_REVISION_MAX}</p>
</main>
<script>
  (() => {
    const root = document.querySelector('[data-sinter-interactive-state]');
    const output = document.querySelector('[data-sinter-state-value]');
    const primary = document.querySelector('[data-control="primary"]');
    const secondary = document.querySelector('[data-control="secondary"]');
    ${transitionInteractiveArtifactState.toString()}
    const apply = (action) => {
      const next = transitionInteractiveArtifactState(root.dataset.sinterInteractiveState, action);
      root.dataset.sinterInteractiveState = next;
      output.textContent = next;
      primary.setAttribute('aria-pressed', String(next === 'primary-activated'));
      secondary.setAttribute('aria-pressed', String(next === 'toggle-pressed'));
    };
    primary.addEventListener('click', () => apply('primary'));
    secondary.addEventListener('click', () => apply('secondary'));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') apply('escape'); });
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    reduced.addEventListener('change', (event) => { if (event.matches) apply('reduce-motion'); });
  })();
</script>`;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function digestCanonicalArtifact(html: string): string {
  const canonical = html.replace(
    /(<meta\s+name="sinter-interactive-artifact-digest"\s+content=")[^"]*(")/i,
    '$1$2',
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Identity-only inspection helper used by tests and the CLI proof. Returns the
 * bounded artifact identity as it appears in the meta tags of the rendered
 * HTML. Browser execution is not required: this is a deterministic string parse.
 */
export function inspectInteractiveArtifactIdentity(html: string): InteractiveArtifactIdentity {
  const schema = matchMeta(html, 'sinter-interactive-artifact-schema');
  if (schema !== INTERACTIVE_ARTIFACT_SCHEMA) {
    throw new Error(`Interactive artifact schema mismatch: expected ${INTERACTIVE_ARTIFACT_SCHEMA}, got ${schema ?? '<absent>'}`);
  }
  const version = matchMeta(html, 'sinter-interactive-artifact-version');
  if (version !== String(INTERACTIVE_ARTIFACT_VERSION)) {
    throw new Error(`Interactive artifact version mismatch: expected ${INTERACTIVE_ARTIFACT_VERSION}, got ${version ?? '<absent>'}`);
  }
  const artifactDigest = matchMeta(html, 'sinter-interactive-artifact-digest');
  if (!artifactDigest || artifactDigest.length !== 64) {
    throw new Error('Interactive artifact digest missing or wrong shape');
  }
  if (digestCanonicalArtifact(html) !== artifactDigest) {
    throw new Error('Interactive artifact digest does not match canonical rendered body');
  }
  const thesisId = matchMeta(html, 'sinter-creative-thesis-id');
  if (!thesisId) throw new Error('Interactive artifact missing thesis id');
  const principleIds = (matchMeta(html, 'sinter-interactive-artifact-principle-ids') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const runtimeId = `runtime-${matchMeta(html, 'sinter-interactive-artifact-runtime') ?? ''}`;
  const revisionsApplied = Number(matchMeta(html, 'sinter-interactive-artifact-revisions') ?? '0');
  if (!Number.isInteger(revisionsApplied) || revisionsApplied < 0) {
    throw new Error('Interactive artifact revisions applied is not a non-negative integer');
  }
  return {
    artifactDigest,
    thesisId,
    principleIds,
    runtimeId,
    revisionsApplied,
  };
}

function matchMeta(html: string, name: string): string | null {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
  const match = re.exec(html);
  return match ? match[1] : null;
}

/**
 * Re-export: bind evidence by exact expected identity. The helper is the
 * single entry point tests should reach through. It asserts digests, ids,
 * revisions, and bounded bound, then returns the parsed identity.
 */
export function assertInteractiveArtifactIdentity(
  html: string,
  expected: InteractiveArtifactIdentity,
): InteractiveArtifactIdentity {
  const observed = inspectInteractiveArtifactIdentity(html);
  if (!isDeepStrictEqual(observed, expected)) {
    throw new Error(`Interactive artifact identity mismatch:\nexpected=${JSON.stringify(expected)}\nobserved=${JSON.stringify(observed)}`);
  }
  return observed;
}

/** Convenience: compile a Creative Thesis and build the artifact in one step. */
export function buildInteractiveArtifactFromBrief(
  brief: string,
  options: BuildInteractiveArtifactOptions & { requestedPrinciples?: readonly string[] } = { runtimeSeed: 'default' },
): { html: string; trace: InteractiveArtifactTrace; thesis: CreativeThesis } {
  const thesis = compileCreativeThesis(brief, { requestedPrinciples: options.requestedPrinciples });
  // Determine the supported selected principles from the explicit request
  // list. The thesis keeps its single selected principle for run-replay;
  // the artifact binds the full set for evidence reach.
  const supportedRequestedIds = (options.requestedPrinciples ?? [])
    .map((id) => resolveCreativePrinciple(id)?.identity.id)
    .filter((id): id is string => id !== undefined);
  const built = buildInteractiveArtifact(thesis, {
    ...options,
    selectedPrincipleIds: supportedRequestedIds.length > 0 ? supportedRequestedIds : options.selectedPrincipleIds,
  });
  return { ...built, thesis };
}
