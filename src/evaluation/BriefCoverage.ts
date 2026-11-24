/**
 * BriefCoverage — deterministic brief-element extraction and judge coverage verification (#1853).
 *
 * Prevents vision/aesthetic judges from awarding high scores to renders that merely
 * match a brief's color palette while omitting the named visual subjects/motifs
 * (e.g. a "VHS sci-fi film feedback tunnel with scanlines" rendered as pretty colors
 * with zero VHS texture, zero scanlines, and zero tunnel geometry).
 *
 * @module evaluation/BriefCoverage
 */

import { answerJson, splitThinking } from '../llm/ModelOutput.js';
import { TAKE_VARIANT_MARKER } from './VisualDiversity.js';

export interface BriefElement {
  id: string;
  label: string;
  tokens: string[];
}

export type ElementPresenceVerdict = 'present' | 'absent' | 'uncertain';

export interface BriefElementCheck {
  element: string;
  id: string;
  verdict: ElementPresenceVerdict;
  evidence?: string;
}

export interface BriefCoverageReport {
  elements: BriefElement[];
  checks: BriefElementCheck[];
  presentElements: string[];
  missingElements: string[];
  uncertainElements: string[];
  coverageRatio: number;
  parsedFromResponse: boolean;
  scoreCap: number;
  repairAdvice: string;
}

export interface BriefCoveragePenaltyResult {
  score: number;
  capped: boolean;
  missingElements: string[];
}

export const MIN_BRIEF_ELEMENTS = 2;
export const MAX_BRIEF_ELEMENTS = 8;

const BOILERPLATE_HEADER_RE =
  /^\s*(?:#{1,6}\s*)?(?:CANONICAL\s+CREATIVE\s+INTELLIGENCE\s+CONTRACT|CREATIVE\s+INTELLIGENCE\s+CONTRACT|SYSTEM\s+CONTRACT|DELIVERABLE\s+CONTRACT|OUTPUT\s+FORMAT|OUTPUT\s+REQUIREMENTS|HARD\s+CONSTRAINTS|TECHNICAL\s+CONSTRAINTS|RUNTIME\s+CONSTRAINTS|DESIGN\s+CONSTRAINTS|EVALUATION\s+RUBRIC|JUDGING\s+RULES|SYSTEM\s+INSTRUCTIONS|INSTRUCTIONS|CONSTRAINTS|REQUIREMENTS|RULES)\b/i;

const BRIEF_MARKER_LINE_RE =
  /^\s*(?:#{1,6}\s*)?(?:USER\s+BRIEF|CREATIVE\s+BRIEF|ART\s+BRIEF|BRIEF|USER\s+PROMPT|PROMPT|SUBJECT|SCENE|CONCEPT)\s*[:\-–—]\s*(.*)$/i;

const INLINE_EXPLICIT_BRIEF_MARKER_RE =
  /(?:^|\n|\.\s+)(?:#{1,6}\s*)?(?:USER\s+BRIEF|CREATIVE\s+BRIEF|ART\s+BRIEF|USER\s+PROMPT)\s*[:\-–—]\s*/i;

const BOILERPLATE_DIRECTIVE_RE =
  /^\s*(?:[-*•]\s*)?(?:always\s+(?:output|return|render|produce|use|follow)|never\s+(?:output|return|use|leave|omit)|do\s+not\s+(?:output|return|use|include|invent)|must\s+(?:output|return|render|be)|return\s+only|output\s+only|respond\s+with|no\s+markdown|follow\s+all\s+(?:rules|constraints)|you\s+are\s+(?:a|an)\s+)/i;

const CLAUSE_CONNECTOR_RE =
  /(?:^|\s+)(?:surrounded\s+by|framed\s+by|layered\s+with|filled\s+with|set\s+against|lit\s+by|rendered\s+as|styled\s+as|and|plus|with|featuring|including|showing|containing|over|under|beneath|above|inside|through|across|against|amid|among|beside|around|into|from|in|on|at|of)(?:\s+|$)/gi;

const LEADING_STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every',
  'its', 'their', 'our', 'your', 'my',
  'make', 'create', 'generate', 'draw', 'render', 'build', 'design', 'craft', 'paint',
  'depict', 'depicting', 'show', 'showing', 'feature', 'featuring', 'display', 'displaying',
  'evoke', 'evoking', 'inspired', 'by', 'like', 'as',
  'very', 'really', 'quite', 'ultra', 'super', 'hyper', 'slightly', 'gently', 'slowly',
  'softly', 'heavily', 'deeply',
  'infinite', 'endless', 'continuous', 'seamless', 'subtle', 'dramatic', 'dynamic',
  'cinematic', 'stunning', 'gorgeous', 'beautiful', 'rich', 'vivid', 'vibrant',
  'intricate', 'detailed', 'complex', 'simple', 'abstract', 'generative', 'interactive',
  'animated', 'procedural', 'stylized', 'classic', 'vintage', 'retro', 'modern',
  'full', 'pure', 'raw', 'sleek', 'bold', 'epic', 'immersive',
  'aesthetic', 'visual', 'visuals', 'look', 'feel', 'vibe', 'mood', 'style', 'scene',
  'piece', 'artwork', 'image', 'canvas', 'frame', 'composition', 'effect', 'effects',
  'element', 'elements',
  '1960s', '1970s', '1980s', '1990s', '2000s', '60s', '70s', '80s', '90s',
]);

const TRAILING_GENERIC_WORDS = new Set([
  'look', 'feel', 'vibe', 'mood', 'style', 'aesthetic', 'effect', 'effects',
  'element', 'elements', 'scene', 'piece', 'artwork', 'visual', 'visuals',
  'image', 'composition', 'background', 'backdrop', 'canvas', 'theme',
  'motif', 'treatment', 'atmosphere', 'setting', 'environment',
]);

const GENERIC_NON_VISUAL_WORDS = new Set([
  ...LEADING_STOP_WORDS,
  ...TRAILING_GENERIC_WORDS,
  'something', 'anything', 'nothing', 'thing', 'things', 'stuff',
  'nice', 'cool', 'good', 'great', 'awesome', 'pretty', 'high', 'low',
  'art', 'code', 'sketch', 'program', 'output', 'result', 'work',
  'color', 'colors', 'colour', 'colours', 'palette', 'hue', 'hues',
  'tone', 'tones', 'motion', 'movement', 'layer', 'layers', 'surface',
  'pattern', 'patterns', 'shape', 'shapes', 'form', 'forms',
]);

const TONE_MODIFIERS = new Set([
  'dark', 'bright', 'deep', 'pale', 'warm', 'cool', 'soft', 'sharp', 'dim', 'muted', 'heavy',
]);

const PRESENT_VERDICT_RE = /^(?:present|yes|true|visible|found|pass|passed|confirmed|clearly[\s_-]?present)$/i;
const ABSENT_VERDICT_RE = /^(?:absent|no|false|missing|none|invisible|omitted|fail|failed|not[\s_-]?present|not[\s_-]?visible|not[\s_-]?found)$/i;

function singularizeWord(word: string): string {
  const lower = word.toLowerCase();
  if (lower.length > 4 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 3 && lower.endsWith('es') && /(?:ch|sh|x|z|s)es$/.test(lower)) return lower.slice(0, -2);
  if (lower.length > 3 && lower.endsWith('s') && !/(?:ss|us|is)$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

function normalizeTokens(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? [];
  return raw.map(token => singularizeWord(token)).filter(token => token.length > 0);
}

function toSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function canonicalKey(tokens: readonly string[]): string {
  return tokens.join(' ');
}

function isAcronymToken(word: string): boolean {
  return /^[A-Z0-9]{2,5}$/.test(word) && /[A-Z]/.test(word);
}

function stripTakeFlavoring(brief: string): string {
  const at = brief.indexOf(TAKE_VARIANT_MARKER);
  return at >= 0 ? brief.slice(0, at) : brief;
}

function stripBoilerplate(brief: string): string {
  const normalized = stripTakeFlavoring(brief).replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  const explicitMatch = INLINE_EXPLICIT_BRIEF_MARKER_RE.exec(normalized);
  if (explicitMatch && explicitMatch.index !== undefined) {
    const afterMarker = normalized.slice(explicitMatch.index + explicitMatch[0].length);
    const lines = afterMarker.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      if (BOILERPLATE_HEADER_RE.test(line)) break;
      if (BOILERPLATE_DIRECTIVE_RE.test(line)) continue;
      kept.push(line);
    }
    return kept.join('\n').trim();
  }

  const lines = normalized.split('\n');
  const kept: string[] = [];
  let inBoilerplate = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^[-=*_]{3,}$/.test(trimmed)) {
      inBoilerplate = false;
      continue;
    }
    const briefMarker = BRIEF_MARKER_LINE_RE.exec(trimmed);
    if (briefMarker) {
      inBoilerplate = false;
      if (briefMarker[1].trim()) kept.push(briefMarker[1].trim());
      continue;
    }
    if (BOILERPLATE_HEADER_RE.test(trimmed)) {
      inBoilerplate = true;
      continue;
    }
    if (inBoilerplate || BOILERPLATE_DIRECTIVE_RE.test(trimmed)) continue;
    kept.push(trimmed.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  }

  return kept.join('\n').trim();
}

function trimPhraseWords(words: string[]): string[] {
  let start = 0;
  let end = words.length;
  while (start < end && LEADING_STOP_WORDS.has(words[start].toLowerCase())) start++;
  while (end > start + 1 && TRAILING_GENERIC_WORDS.has(words[end - 1].toLowerCase())) end--;
  return words.slice(start, end);
}

function splitNounStack(words: string[]): string[][] {
  const chunks: string[][] = [];
  let remaining = trimPhraseWords(words);
  if (remaining.length === 0) return chunks;

  while (remaining.length >= 3 && isAcronymToken(remaining[0])) {
    chunks.push([remaining[0]]);
    remaining = trimPhraseWords(remaining.slice(1));
  }
  while (remaining.length >= 4 && remaining[0].includes('-')) {
    chunks.push(remaining.slice(0, 2));
    remaining = trimPhraseWords(remaining.slice(2));
  }
  if (remaining.length === 0) return chunks;
  if (remaining.length === 4 && TONE_MODIFIERS.has(remaining[0].toLowerCase())) {
    remaining = remaining.slice(1);
  }
  if (remaining.length <= 3) {
    chunks.push(remaining);
    return chunks;
  }
  let idx = 0;
  while (idx < remaining.length) {
    const left = remaining.length - idx;
    if (left <= 3) {
      chunks.push(remaining.slice(idx));
      break;
    }
    chunks.push(remaining.slice(idx, idx + 2));
    idx += 2;
  }
  return chunks;
}

function isConcretePhrase(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  if (words.length === 1 && (words[0].length < 2 || /^\d+$/.test(words[0]))) return false;
  return words.some(w => {
    const lower = w.toLowerCase();
    if (/^\d+$/.test(lower)) return false;
    if (isAcronymToken(w)) return true;
    return !GENERIC_NON_VISUAL_WORDS.has(lower);
  });
}

export function extractBriefElements(brief: string): BriefElement[] {
  const cleaned = stripBoilerplate(brief);
  if (!cleaned) return [];

  const rawClauses = cleaned
    .split(/[\n.;!?—–:]+|,\s*/)
    .flatMap(clause => clause.split(CLAUSE_CONNECTOR_RE))
    .map(part => part.trim())
    .filter(part => part.length > 0);

  const elements: BriefElement[] = [];
  const seenKeys = new Set<string>();

  for (const clause of rawClauses) {
    const words = clause.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? [];
    if (words.length === 0) continue;

    for (const chunk of splitNounStack(words)) {
      const trimmed = trimPhraseWords(chunk);
      if (!isConcretePhrase(trimmed)) continue;
      const label = trimmed.join(' ');
      const tokens = normalizeTokens(label);
      if (tokens.length === 0) continue;
      const key = canonicalKey(tokens);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      elements.push({ id: toSlug(label) || key.replace(/\s+/g, '-'), label, tokens });
      if (elements.length >= MAX_BRIEF_ELEMENTS) return elements;
    }
  }
  return elements;
}

export function formatBriefCoveragePrompt(elements: readonly BriefElement[]): string {
  if (elements.length === 0) return '';
  const numbered = elements.map((el, idx) => `${idx + 1}. ${el.label}`).join('\n');
  const examplePairs = elements.slice(0, 2).map((el, idx) => `${el.label}=${idx === 0 ? 'present' : 'absent'}`).join(', ');
  return [
    'Brief coverage checklist — verify whether EACH named brief element is actually visible in the rendered artifact (matching only the color palette or mood does NOT count):',
    numbered,
    'Report each element as present or absent using EITHER:',
    '- JSON field: "briefCoverage": [{"element":"<name>","present":true|false}]',
    `- Text line: BRIEF_COVERAGE: ${examplePairs}`,
  ].join('\n');
}

interface RawVerdictEntry {
  rawName: string;
  verdict: ElementPresenceVerdict;
  evidence?: string;
}

function classifyVerdict(value: unknown): ElementPresenceVerdict {
  if (typeof value === 'boolean') return value ? 'present' : 'absent';
  if (typeof value === 'number') return value >= 0.5 ? 'present' : value >= 0 ? 'absent' : 'uncertain';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (PRESENT_VERDICT_RE.test(trimmed)) return 'present';
    if (ABSENT_VERDICT_RE.test(trimmed)) return 'absent';
  }
  return 'uncertain';
}

function parseCoverageTextBlock(text: string): RawVerdictEntry[] {
  const entries: RawVerdictEntry[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  const headerMatch = normalized.match(/BRIEF_COVERAGE\s*:\s*([^\n]*)/i);
  if (!headerMatch || headerMatch.index === undefined) return entries;

  const segments: string[] = [];
  if (headerMatch[1].trim().length > 0) segments.push(...headerMatch[1].trim().split(/[,;]+/));

  const afterHeader = normalized.slice(headerMatch.index + headerMatch[0].length);
  for (const line of afterHeader.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || /^[A-Z][A-Z0-9_ ]{2,}\s*:/.test(trimmed)) break;
    segments.push(trimmed.replace(/^(?:[-*•]|\d+[.)])\s*/, ''));
  }

  for (const segment of segments) {
    const cleaned = segment.trim().replace(/\.+$/, '');
    if (!cleaned) continue;
    const pairMatch = cleaned.match(/^(.+?)\s*(?:=|:|\s+-\s+)\s*([a-zA-Z_-]+(?:\s+[a-zA-Z_-]+)?)(?:\s*\((.+)\))?$/);
    if (!pairMatch) continue;
    const rawName = pairMatch[1].replace(/^["'`]+|["'`]+$/g, '').trim();
    const verdict = classifyVerdict(pairMatch[2]);
    const evidence = pairMatch[3]?.trim();
    if (rawName && verdict !== 'uncertain') {
      entries.push({ rawName, verdict, ...(evidence ? { evidence } : {}) });
    }
  }
  return entries;
}

function parseCoverageFromJson(response: string): RawVerdictEntry[] {
  const jsonText = answerJson(response).trim();
  if (!jsonText.startsWith('{') && !jsonText.startsWith('[')) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(jsonText); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];

  const record = parsed as Record<string, unknown>;
  const field = record.briefCoverage ?? record.brief_coverage;
  if (field === undefined || field === null) return [];
  if (typeof field === 'string') return parseCoverageTextBlock(`BRIEF_COVERAGE: ${field}`);

  if (Array.isArray(field)) {
    const entries: RawVerdictEntry[] = [];
    for (const item of field) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const rawName = typeof obj.element === 'string' ? obj.element
        : typeof obj.label === 'string' ? obj.label
          : typeof obj.name === 'string' ? obj.name
            : typeof obj.id === 'string' ? obj.id : '';
      if (!rawName.trim()) continue;
      const verdict = classifyVerdict(obj.present ?? obj.verdict ?? obj.status ?? obj.visible);
      const evidence = typeof obj.evidence === 'string' && obj.evidence.trim() ? obj.evidence.trim() : undefined;
      entries.push({ rawName: rawName.trim(), verdict, ...(evidence ? { evidence } : {}) });
    }
    return entries;
  }

  if (typeof field === 'object') {
    const entries: RawVerdictEntry[] = [];
    for (const [key, val] of Object.entries(field as Record<string, unknown>)) {
      const verdict = classifyVerdict(val);
      if (key.trim() && verdict !== 'uncertain') entries.push({ rawName: key.trim(), verdict });
    }
    return entries;
  }
  return [];
}

function matchScore(element: BriefElement, rawName: string): number {
  const rawSlug = toSlug(rawName);
  if (rawSlug && rawSlug === element.id) return 1.0;
  const rawTokens = normalizeTokens(rawName);
  if (rawTokens.length === 0 || element.tokens.length === 0) return 0;
  if (canonicalKey(rawTokens) === canonicalKey(element.tokens)) return 0.95;
  const elemSet = new Set(element.tokens);
  const rawSet = new Set(rawTokens);
  let overlap = 0;
  for (const token of rawSet) if (elemSet.has(token)) overlap++;
  if (overlap === 0) return 0;
  const union = new Set([...elemSet, ...rawSet]).size;
  return (overlap / Math.min(elemSet.size, rawSet.size)) * 0.6 + (overlap / union) * 0.4;
}

function computeScoreCap(coverageRatio: number, missingCount: number): number {
  if (missingCount === 0) return 1;
  const cap = 0.35 + coverageRatio * 0.4;
  return Math.round(Math.min(0.74, Math.max(0.35, cap)) * 1000) / 1000;
}

export function parseBriefCoverage(
  response: string,
  elements: readonly BriefElement[],
): BriefCoverageReport {
  const elementList = [...elements];
  if (elementList.length === 0) {
    return {
      elements: [],
      checks: [],
      presentElements: [],
      missingElements: [],
      uncertainElements: [],
      coverageRatio: 1,
      parsedFromResponse: false,
      scoreCap: 1,
      repairAdvice: '',
    };
  }

  const { answer } = splitThinking(response);
  const jsonEntries = parseCoverageFromJson(response);
  const rawEntries = jsonEntries.length > 0 ? jsonEntries : parseCoverageTextBlock(answer);

  const matchedEntries = new Map<number, RawVerdictEntry>();
  const usedRawIndices = new Set<number>();
  const candidates: Array<{ elemIdx: number; rawIdx: number; score: number }> = [];
  for (let eIdx = 0; eIdx < elementList.length; eIdx++) {
    for (let rIdx = 0; rIdx < rawEntries.length; rIdx++) {
      const score = matchScore(elementList[eIdx], rawEntries[rIdx].rawName);
      if (score >= 0.5) candidates.push({ elemIdx: eIdx, rawIdx: rIdx, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.elemIdx - b.elemIdx || a.rawIdx - b.rawIdx);
  for (const candidate of candidates) {
    if (matchedEntries.has(candidate.elemIdx) || usedRawIndices.has(candidate.rawIdx)) continue;
    matchedEntries.set(candidate.elemIdx, rawEntries[candidate.rawIdx]);
    usedRawIndices.add(candidate.rawIdx);
  }

  const checks: BriefElementCheck[] = elementList.map((el, idx) => {
    const matched = matchedEntries.get(idx);
    return {
      element: el.label,
      id: el.id,
      verdict: matched?.verdict ?? 'uncertain',
      ...(matched?.evidence ? { evidence: matched.evidence } : {}),
    };
  });

  const presentElements = checks.filter(c => c.verdict === 'present').map(c => c.element);
  const missingElements = checks.filter(c => c.verdict === 'absent').map(c => c.element);
  const uncertainElements = checks.filter(c => c.verdict === 'uncertain').map(c => c.element);
  const decidedCount = presentElements.length + missingElements.length;
  const parsedFromResponse = decidedCount > 0;
  const coverageRatio = parsedFromResponse ? Math.round((presentElements.length / decidedCount) * 1000) / 1000 : 1;
  const scoreCap = parsedFromResponse ? computeScoreCap(coverageRatio, missingElements.length) : 1;
  const repairAdvice = missingElements.length > 0
    ? `Missing brief elements (${missingElements.length}/${elementList.length}): ${missingElements.join(', ')}. Render clear, recognizable visual structure for each missing element rather than relying on palette or mood alone.`
    : '';

  return {
    elements: elementList,
    checks,
    presentElements,
    missingElements,
    uncertainElements,
    coverageRatio,
    parsedFromResponse,
    scoreCap,
    repairAdvice,
  };
}

export function applyBriefCoveragePenalty(
  score: number,
  report: BriefCoverageReport,
): BriefCoveragePenaltyResult {
  const clamped = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  if (!report.parsedFromResponse || report.missingElements.length === 0) {
    return { score: Math.round(clamped * 1000) / 1000, capped: false, missingElements: [] };
  }
  const capped = clamped > report.scoreCap;
  return {
    score: Math.round((capped ? report.scoreCap : clamped) * 1000) / 1000,
    capped,
    missingElements: [...report.missingElements],
  };
}
