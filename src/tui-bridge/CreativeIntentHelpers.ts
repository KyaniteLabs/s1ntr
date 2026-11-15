/**
 * CreativeIntentHelpers — extracted from TuiBridgeService (F20 split)
 *
 * Creative intent analysis, clarification prompts, preference hints, and
 * domain-mismatch detection. Most functions are pure; the emit-dependent
 * ones receive an IntentEmitContext.
 */

import type { TuiBridgeEvent, TuiInputRequest } from './types.js';
import type { TuiSessionStatus } from './types.js';
import { Domain } from '../types/domains.js';
import type { Domain as ChatDomain } from '../chat/types.js';
import { AmbiguityDetector } from '../core/AmbiguityDetector.js';
import {
  buildCreativePreferencePromptHints,
  createCreativePreferenceSuggestion,
} from '../chat/CreativePreferenceGuide.js';
import { validateGeneratedDomainForRequest } from './CreativeDomainRouting.js';
import { buildLearnedTasteLine } from '../harness/learnedTaste.js';
import type { ConversationManager } from '../chat/ConversationManager.js';

// ── Types ──

export interface CreativeIntentBrief {
  userRequest: string;
  requirements: string[];
  missingDetails: string[];
  questions: string[];
  shouldClarify: boolean;
  reason: string;
}

export interface IntentEmitContext {
  emit(sessionId: string, event: TuiBridgeEvent): void;
  updateSession(sessionId: string, patch: Partial<TuiSessionStatus>): TuiSessionStatus;
}

// ── Pure functions ──

export function extractUserPrompt(userText: string): string {
  const match = userText.match(/(?:^|\n)User prompt:\s*([\s\S]+)$/i);
  return (match?.[1] ?? userText).trim();
}

export function toChatDomain(domain: Domain | string): ChatDomain {
  const value = String(domain);
  if (value === Domain.GLSL || value === Domain.WEBGL) return 'shader';
  if (value === Domain.TONE) return 'music';
  if (value === Domain.REVIDEO || value === Domain.HYPERFRAMES) return 'revideo';
  if (['p5', 'shader', 'three', 'music', 'hydra', 'strudel', 'revideo'].includes(value)) {
    return value as ChatDomain;
  }
  return 'p5';
}

export function cleanPreferenceAnswers(answers: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return {};
  return Object.fromEntries(
    Object.entries(answers)
      .filter(([key, value]) => key !== 'priorRunReceipt' && key !== 'revisionKind' && value != null && String(value).trim() !== ''),
  );
}

export function describeStrictDomainMismatch(code: string, requestedDomain: Domain, domainPlan: Domain[]): string | null {
  if (domainPlan.length !== 1) return null;
  const validation = validateGeneratedDomainForRequest(code, requestedDomain);
  return validation.ok ? null : validation.message ?? 'Generated artifact did not match the requested domain';
}

export function domainCorrectionPrompt(originalPrompt: string, requestedDomain: Domain, mismatch: string): string {
  return [
    originalPrompt,
    '',
    `Reject the previous answer: ${mismatch}.`,
    `The requested creative domain is locked to ${requestedDomain}; do not switch frameworks or languages.`,
    `Return only valid ${requestedDomain} artifact code with no prose or markdown.`,
  ].join('\n');
}

export function buildCreativePreferenceLines(
  userText: string,
  domain: Domain | string,
  options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'>,
): string[] {
  const answers = {
    ...cleanPreferenceAnswers(options.creativePreferences),
    ...cleanPreferenceAnswers(options.guidanceAnswers),
  };

  // Palette is honored LITERALLY. The inference path maps recognized colour
  // *words* to canned hints and never echoes the user's exact palette string,
  // so a chosen palette (e.g. "teal/rust") would otherwise be silently dropped.
  const paletteRaw = answers.palette;
  const palette = typeof paletteRaw === 'string' ? paletteRaw.trim() : '';
  const literalLines = palette ? [`Preferred palette: ${palette}`] : [];

  const inferenceAnswers = { ...answers };
  delete inferenceAnswers.palette;
  const hints = Object.keys(inferenceAnswers).length === 0
    ? []
    : buildCreativePreferencePromptHints({
        domain: toChatDomain(domain),
        prompt: extractUserPrompt(userText),
        answers: inferenceAnswers,
      });

  const allHints = [...literalLines, ...hints];
  if (allHints.length === 0) return [];

  return [
    '',
    'Creative preferences (user-confirmed, optional):',
    ...allHints.map(hint => `- ${hint}`),
  ];
}

export function buildCreativeIntentBrief(userText: string): CreativeIntentBrief {
  const userRequest = extractUserPrompt(userText);
  const detector = new AmbiguityDetector();
  const issues = detector.detect(userRequest);
  const words = userRequest.split(/\s+/).filter(Boolean);
  const lower = userRequest.toLowerCase();
  const hasColor = /\b(red|orange|yellow|green|blue|purple|violet|pink|white|black|gold|silver|cyan|magenta|monochrome|neon|pastel)\b/.test(lower);
  const hasMotion = /\b(dance|dancing|move|moving|rotate|spinning|pulse|breath|breathes|breathing|flow|grow|morph|animate|animated|kinetic)\b/.test(lower);
  const hasStyle = /\b(glass|metal|organic|alien|soft|hard|minimal|detailed|surreal|realistic|abstract|luminous|dark|bright|noir|retro|cyberpunk)\b/.test(lower);
  const subjectStopWords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'create', 'draw', 'for', 'from', 'generate',
    'in', 'into', 'make', 'of', 'on', 'or', 'sketch', 'the', 'to', 'with',
  ]);
  const vagueSubjectWords = new Set(['better', 'cooler', 'interesting', 'it', 'nice', 'nicer', 'something', 'stuff', 'that', 'things', 'this']);
  const hasNamedVisualObject = /\b(aurora|bird|boat|building|butterfly|castle|city|cloud|comet|creature|crystal|diagram|dragon|fish|flower|forest|galaxy|iceberg|icebergs|icon|island|landscape|logo|machine|moon|mountain|ocean|organism|pattern|planet|portrait|river|robot|scene|shader|ship|sky|star|stars|storm|tree|wave|waves)\b/.test(lower);
  const hasConcreteNounHint = words.some((word) => {
    const cleaned = word.replace(/[^a-zA-Z]/g, '').toLowerCase();
    return cleaned.length >= 4 && !subjectStopWords.has(cleaned) && !vagueSubjectWords.has(cleaned);
  });
  const hasSubject = hasNamedVisualObject || hasConcreteNounHint;
  const highIssues = issues.filter((issue) => (
    issue.severity === 'high' &&
    !(issue.type === 'missing_context' && (words.length >= 10 || hasSubject))
  ));
  const requirements = [
    `Primary request: ${userRequest}`,
    hasSubject ? 'Preserve the named subject and objects from the prompt.' : 'User has not named a concrete subject yet.',
    hasColor ? 'Preserve explicit color and palette cues.' : 'No explicit palette was provided.',
    hasMotion ? 'Preserve explicit motion or behavior cues.' : 'No explicit motion/behavior was provided.',
    hasStyle ? 'Preserve explicit style/material/mood cues.' : 'No explicit style/material/mood was provided.',
  ];
  const missingDetails = [
    !hasSubject ? 'subject' : '',
    !hasColor ? 'palette' : '',
    !hasMotion ? 'motion' : '',
    !hasStyle ? 'style/material' : '',
  ].filter(Boolean);
  const questions = [
    ...highIssues.map((issue) => issue.suggestedQuestion),
    !hasSubject ? 'What is the main subject or object that must be recognizable?' : '',
    !hasColor ? 'What palette or color mood should dominate?' : '',
    !hasMotion ? 'Should it be still, looping, breathing, dancing, morphing, or interactive?' : '',
    !hasStyle ? 'What material or aesthetic should it feel like?' : '',
  ].filter(Boolean).slice(0, 4);
  const shouldClarify = highIssues.length > 0 || (!hasSubject && (words.length < 3 || (!hasColor && !hasMotion && !hasStyle)));
  const reason = highIssues[0]?.description || (words.length < 3 ? 'Prompt is too short to preserve intent reliably.' : 'Prompt is missing a concrete subject.');

  return {
    userRequest,
    requirements,
    missingDetails,
    questions,
    shouldClarify,
    reason,
  };
}

/**
 * One concise aesthetic directive per domain bucket. Pushes the generator
 * toward a genuinely strong result (composition, contrast, motion) and toward
 * honoring the user's concrete details — without overriding the request or
 * bloating the prompt. Audio domains get a musical bar instead of a visual one;
 * unknown domains get none (the technical instruction stands alone).
 */
export function aestheticDirective(domain: Domain): string {
  const RICH_VISUAL = new Set<Domain>([Domain.THREE, Domain.P5, Domain.GLSL, Domain.SHADER, Domain.WEBGL, Domain.HYDRA]);
  const TEXT_VISUAL = new Set<Domain>([Domain.KINETIC, Domain.ASCII]);
  const AUDIO = new Set<Domain>([Domain.TONE, Domain.STRUDEL, Domain.MUSIC]);
  if (RICH_VISUAL.has(domain)) {
    return 'Quality bar: make it genuinely striking, not a placeholder — a strong focal composition, a deliberate palette with real contrast (never washed-out, muddy, or near-empty), a sense of depth, and continuous fluid motion. Honor every concrete detail named in the request.';
  }
  if (TEXT_VISUAL.has(domain)) {
    return 'Quality bar: make it genuinely striking — strong composition, bold contrast, and lively continuous motion; never sparse, flat, or static. Honor every concrete detail named in the request.';
  }
  if (AUDIO.has(domain)) {
    return 'Quality bar: make it genuinely musical — a clear groove or evolving texture with intentional rhythm, dynamics, and movement; never a single static tone. Honor every concrete detail named in the request.';
  }
  return '';
}

export function promptForCreativeDomain(
  userText: string,
  domain: Domain,
  fallback: boolean,
  intentBrief?: CreativeIntentBrief,
  options: Pick<TuiInputRequest, 'creativePreferences' | 'guidanceAnswers'> & {
    /** Bridge-resolved excerpt of the prior artifact for revise/variation/polish. */
    priorArtifactExcerpt?: string;
  } = {},
): string {
  const prefix = fallback
    ? `Previous generation route failed. Retry the original request as ${domain}.`
    : `Target creative domain: ${domain}.`;
  const domainInstruction = domain === Domain.THREE
    ? 'Return raw Three.js scene code only. Do not return SVG, p5, prose, or markdown. Set renderer.toneMapping = THREE.ACESFilmicToneMapping and toneMappingExposure ~1.0; keep AmbientLight 0.25-0.6 and key lights 0.8-2.0 (never Math.PI ambient or intensity ≥ 3); use a deep mid-tone background and dark/mid floor — never a blown white frame. Expose an audio-reactive object by reading window.__liminalAudio each animation frame; map rms/energy to scale/brightness and centroid/brightness to hue/material intensity.'
    : domain === Domain.P5
      ? 'Return raw p5.js sketch code only. Do not return any other framework, markup, prose, or markdown. Full-canvas composition with intentional focal structure — never sparse dim points letterboxed into empty near-black. Particle/point fields need ≥120 elements, size upper bound ≥12px, high subject alpha (~140–255) and soft glow/halos on dark grounds so the frame reads luminous. Read window.__liminalAudio inside draw(); map rms/energy to scale/brightness and centroid/brightness to hue/motion.'
      : domain === Domain.GLSL || domain === Domain.SHADER || domain === Domain.WEBGL
        ? 'Return raw GLSL fragment shader code only. Do not return SVG, p5, prose, or markdown.'
        : domain === Domain.HYDRA
          ? 'Return raw Hydra video-synth code only. Do not return SVG, p5, prose, or markdown.'
          : domain === Domain.KINETIC
            ? 'Return a complete raw HTML/CSS kinetic typography artifact only. Include visible animated text or letter elements and CSS @keyframes. Do not return p5, SVG-only output, prose, or markdown.'
            : `Return raw ${domain} artifact code only. Do not return SVG unless the target domain is SVG.`;
  const briefLines = intentBrief
    ? [
        'Intent brief:',
        `- User request: ${intentBrief.userRequest}`,
        ...intentBrief.requirements.map((requirement) => `- ${requirement}`),
        intentBrief.missingDetails.length > 0
          ? `- Unknown details: ${intentBrief.missingDetails.join(', ')}. Make conservative choices, but do not ignore explicit requirements.`
          : '- Unknown details: none significant.',
      ]
    : [];
  const preferenceHints = buildCreativePreferenceLines(userText, domain, options);
  // Bridge-owned prior artifact for revisions. Pure render only — I/O lives in
  // TuiBridgeService.resolvePriorArtifactExcerpt so this helper stays pure.
  // Fence length is max(3, longest backtick run in the excerpt + 1) so a ```
  // inside the excerpt cannot close the fence early and leak surrounding prose.
  const priorArtifactLines = options.priorArtifactExcerpt
    ? (() => {
        const excerpt = options.priorArtifactExcerpt;
        const runs = excerpt.match(/`+/g);
        const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return [
          '',
          'Current artifact code (revise it, do not start over):',
          fence,
          excerpt,
          fence,
        ];
      })()
    : [];
  // The artist's learned taste from past sessions (StudioReflection → harness
  // memory). Both Studio paths build their prompt here, so wiring it once feeds
  // the taste flywheel into the default Generate AND Polish. Cheap in-memory
  // read; never throws (degrades to no line).
  const tasteLine = buildLearnedTasteLine();
  // A concise aesthetic bar. The technical domainInstruction tells the model
  // WHAT to return; this tells it to make that thing genuinely good instead of
  // a bland placeholder — and to honor what the user actually asked for. Kept
  // to one line so it never crowds out the "return raw code" contract.
  const aesthetic = aestheticDirective(domain);
  return [
    userText,
    '',
    ...briefLines,
    ...preferenceHints,
    ...priorArtifactLines,
    ...(tasteLine ? ['', tasteLine] : []),
    ...(aesthetic ? ['', aesthetic] : []),
    '',
    prefix,
    domainInstruction,
  ].join('\n');
}

/** Words too generic to signal whether a generation honored the request. */
const ADHERENCE_STOPWORDS = new Set([
  'create', 'draw', 'make', 'generate', 'sketch', 'render', 'build', 'show', 'design',
  'with', 'that', 'this', 'into', 'from', 'some', 'your', 'using', 'about', 'like',
  'animated', 'animation', 'scene', 'piece', 'work', 'something', 'really', 'very',
]);

/**
 * Static content-adherence score (0..1) of a generated artifact against the
 * user's request: the fraction of concrete request words (≥4 letters, not
 * generic) that appear anywhere in the code/comments. Noisy by design — code
 * doesn't always echo prompt words — so it is only ever used as a TIEBREAK
 * among candidates of comparable quality, never as a gate. Returns 1 (neutral)
 * when the request has no concrete words to check.
 */
export function scoreContentAdherence(code: string, userRequest: string): number {
  const tokens = [
    ...new Set(
      (userRequest.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(word => !ADHERENCE_STOPWORDS.has(word)),
    ),
  ];
  if (tokens.length === 0) return 1;
  const haystack = code.toLowerCase();
  const matched = tokens.filter(token => haystack.includes(token)).length;
  return matched / tokens.length;
}

// ── Emit-dependent functions ──

export function emitIntentBrief(ctx: IntentEmitContext, sessionId: string, intentBrief: CreativeIntentBrief): void {
  ctx.emit(sessionId, {
    type: 'generation.intent_brief',
    sessionId,
    userRequest: intentBrief.userRequest,
    requirements: intentBrief.requirements,
    missingDetails: intentBrief.missingDetails,
    questions: intentBrief.questions,
    willClarify: intentBrief.shouldClarify,
  });
}

export function emitReasoningTrace(
  ctx: IntentEmitContext,
  sessionId: string,
  trace: { phase: string; thought: string; model?: string; detail?: string; source?: 'harness' | 'generator' | 'evaluator' },
): void {
  ctx.emit(sessionId, {
    type: 'generation.reasoning_trace',
    sessionId,
    ...trace,
  });
}

export function emitCreativeClarification(
  ctx: IntentEmitContext,
  sessionId: string,
  intentBrief: CreativeIntentBrief,
  conversation: ConversationManager,
): void {
  const content = [
    'I need to clarify this before generating so I do not guess wrong.',
    '',
    ...intentBrief.questions.map((question, index) => `${index + 1}. ${question}`),
  ].join('\n');
  ctx.emit(sessionId, {
    type: 'generation.clarification_needed',
    sessionId,
    questions: intentBrief.questions,
    reason: intentBrief.reason,
  });
  ctx.emit(sessionId, { type: 'response.delta', sessionId, delta: content });
  ctx.emit(sessionId, { type: 'response.completed', sessionId, content });
  ctx.emit(sessionId, { type: 'response.committed', sessionId, content });
  conversation.appendMessage('assistant', content);
  ctx.emit(sessionId, {
    type: 'status.updated',
    sessionId,
    status: ctx.updateSession(sessionId, {
      mode: 'chat',
      activeTask: 'Clarifying generation intent',
    }),
  });
}

export function emitCreativePreferenceGuidance(
  ctx: IntentEmitContext,
  sessionId: string,
  userText: string,
  domain: Domain | string,
): boolean {
  const prompt = extractUserPrompt(userText);
  const suggestion = createCreativePreferenceSuggestion({
    prompt,
    domain: toChatDomain(domain),
    techniques: [],
    constraints: [],
    references: [],
    iteration: 0,
    currentScore: 0,
  });
  if (!suggestion) return false;

  const questions = suggestion.description
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(Boolean);

  ctx.emit(sessionId, {
    type: 'guidance.suggestion',
    sessionId,
    category: 'creative-preferences',
    title: suggestion.title,
    description: suggestion.description,
    priority: suggestion.priority,
    optional: true,
    questions,
  });
  return true;
}

export function emitPriorRunReceiptLink(
  ctx: IntentEmitContext,
  sessionId: string,
  options: Pick<TuiInputRequest, 'creativePreferences'>,
): void {
  const preferences = options.creativePreferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return;
  const prior = preferences.priorRunReceipt;
  if (!prior || typeof prior !== 'object' || Array.isArray(prior)) return;
  const priorRecord = prior as {
    phase?: unknown;
    creativeDomain?: unknown;
    artifact?: { label?: unknown; path?: unknown };
    preview?: { type?: unknown };
  };
  const revisionKindValue = String(preferences.revisionKind || 'revision');
  const revisionKind = ['revise', 'variation', 'polish', 'revision'].includes(revisionKindValue)
    ? revisionKindValue as 'revise' | 'variation' | 'polish' | 'revision'
    : 'revision';
  const artifact = priorRecord.artifact && typeof priorRecord.artifact === 'object'
    ? priorRecord.artifact
    : undefined;
  const previewType = priorRecord.preview?.type;
  ctx.emit(sessionId, {
    type: 'generation.receipt.linked',
    sessionId,
    revisionKind,
    priorPhase: typeof priorRecord.phase === 'string' ? priorRecord.phase : undefined,
    priorDomain: typeof priorRecord.creativeDomain === 'string' ? priorRecord.creativeDomain : undefined,
    priorArtifactLabel: typeof artifact?.label === 'string' ? artifact.label : undefined,
    priorArtifactPath: typeof artifact?.path === 'string' ? artifact.path : undefined,
    priorPreviewType: typeof previewType === 'string' && ['code', 'image', 'html', 'music'].includes(previewType)
      ? previewType as 'code' | 'image' | 'html' | 'music'
      : undefined,
  });
}
