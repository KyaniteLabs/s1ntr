/**
 * The one place S1NTR reads structure out of raw model text.
 *
 * Every other module asks this one for the answer, the code, or the JSON.
 * Hand-written fence or think regexes elsewhere are a lint error
 * (.eslintrc.cjs, no-restricted-syntax): each copy drifted on a different
 * edge (```tsx, CRLF, ~~~, an unclosed fence, an unclosed <think>) and scored
 * correct model answers as failures.
 */

export interface ModelReply {
  readonly thinking: string;
  readonly answer: string;
  /** False when the text ended inside an open think block. */
  readonly thinkClosed: boolean;
}

export interface FencedBlock {
  /** Lowercased first word of the info string; '' when the fence has none. */
  readonly lang: string;
  /** Line index of the opening fence and one past the last line the block owns. */
  readonly start: number;
  readonly end: number;
  /** Lines between the fences, verbatim, joined with '\n'. */
  readonly body: string;
  readonly closed: boolean;
}

const THINK_TAG_SOURCE = String.raw`<(\/?)(?:think|thinking|thinkcontent|reasoning|analysis)\b[^<>]*>`;
const thinkTags = (): RegExp => new RegExp(THINK_TAG_SOURCE, 'gi');

/** Separate reasoning from the answer. Handles closed blocks, a block left
 *  open when the budget ran out, and an orphan close tag (chat templates that
 *  open the think block inside the prompt). A reply without tags comes back
 *  verbatim; otherwise only the blank lines after the reasoning go, so
 *  artwork keeps its layout. */
export function splitThinking(raw: string): ModelReply {
  const thinking: string[] = [];
  let answer = '';
  let depth = 0;
  let cursor = 0;
  let openedAt = 0;
  let tagged = false;
  for (const tag of raw.matchAll(thinkTags())) {
    tagged = true;
    const at = tag.index ?? 0;
    const closing = tag[1] === '/';
    if (!closing) {
      if (depth === 0) {
        answer += raw.slice(cursor, at);
        openedAt = at + tag[0].length;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) thinking.push(raw.slice(openedAt, at));
    } else {
      thinking.push(answer + raw.slice(cursor, at));
      answer = '';
    }
    cursor = at + tag[0].length;
  }
  if (depth > 0) {
    thinking.push(raw.slice(openedAt));
    return { thinking: joinThoughts(thinking), answer: dropLeadingBlankLines(answer), thinkClosed: false };
  }
  if (!tagged) return { thinking: '', answer: raw, thinkClosed: true };
  answer += raw.slice(cursor);
  return { thinking: joinThoughts(thinking), answer: dropLeadingBlankLines(answer), thinkClosed: true };
}

function joinThoughts(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join('\n\n');
}

export function hasThinkTags(text: string): boolean {
  return thinkTags().test(text);
}

/** The text with think tags removed and their words kept, for recovery that
 *  scans reasoning too. */
export function withoutThinkTags(text: string): string {
  return text.replace(thinkTags(), '');
}

const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\r\n]*?)[ \t]*$/;
const CLOSE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
const ONE_LINE_FENCE = /^[ \t]*(`{3,})([^`]+)\1(?!`)/;
const LANG_WORD = /^[.{]*[a-z][\w.+#-]*\}*$/i;

/** Every fenced block in the text, in order. An unclosed fence runs to the
 *  end of the text. A backtick fence glued to the last code line ("}```")
 *  also closes, and "```x = 1;```" on one line is a block. A tilde run opens
 *  a fence only with a language word ("~~~js"), and a bare backtick fence
 *  that never closes opens one only when it is three backticks with code
 *  under it: "~~~ * ~~~" and "``````" rows are ASCII art. A bare fence
 *  under unfenced code closes it (see orphanClose). */
export function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const oneLine = ONE_LINE_FENCE.exec(lines[i]);
    if (oneLine) {
      blocks.push({ lang: '', start: i, end: i + 1, body: oneLine[2], closed: true });
      i += 1;
      continue;
    }
    const open = OPEN_FENCE.exec(lines[i]);
    const word = open?.[2].split(/\s+/)[0] ?? '';
    if (!open || (open[1][0] === '`' ? open[2].includes('`') : !LANG_WORD.test(word))) {
      i += 1;
      continue;
    }
    const orphan = open[1] === '```' && open[2] === '' ? orphanClose(lines, blocks.at(-1)?.end ?? 0, i) : null;
    if (orphan) {
      blocks.push(orphan);
      i += 1;
      continue;
    }
    const start = i;
    const fence = open[1];
    const lang = word.replace(/^[.{]+|[}]+$/g, '').toLowerCase();
    const body: string[] = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      const close = CLOSE_FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        closed = true;
        i += 1;
        break;
      }
      if (fence[0] === '`' && line.trimEnd().endsWith(fence) && !line.trimEnd().slice(0, -fence.length).endsWith('`')) {
        body.push(line.trimEnd().slice(0, -fence.length));
        closed = true;
        i += 1;
        break;
      }
      body.push(line);
      i += 1;
    }
    if (!closed && lang === '' && (fence.length > 3 || body.every((line) => line.trim() === ''))) {
      i = start + 1;
      continue;
    }
    blocks.push({ lang, start, end: i, body: body.join('\n'), closed });
  }
  return blocks;
}

const CODE_LINE = /[;{})]\s*$|^\s*(?:#|\/\/)/;

/** A bare fence that closes code the model never opened ("void main() {...}"
 *  then "```", then prose). Read as an opener, it shifts every later pair and
 *  the prose between the model's drafts becomes the "code". It closes when the
 *  unfenced run above it is mostly code ending on a code line and the next
 *  text below it is not code. */
function orphanClose(lines: readonly string[], from: number, at: number): FencedBlock | null {
  const run = lines.slice(from, at);
  const first = run.findIndex((line) => CODE_LINE.test(line));
  if (first < 0) return null;
  const body = run.slice(first);
  const filled = body.filter((line) => line.trim() !== '');
  const code = filled.filter((line) => CODE_LINE.test(line)).length;
  if (code < 2 || code * 2 < filled.length || !CODE_LINE.test(filled[filled.length - 1])) return null;
  const next = lines.slice(at + 1).find((line) => line.trim() !== '');
  if (next !== undefined && (CODE_LINE.test(next) || OPEN_FENCE.test(next))) return null;
  return { lang: '', start: from + first, end: at + 1, body: body.join('\n'), closed: true };
}

export function hasFence(text: string): boolean {
  return fencedBlocks(text).length > 0;
}

/** The text with every fenced block removed: the prose around the code. */
export function proseOutsideFences(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let cursor = 0;
  for (const block of fencedBlocks(text)) {
    kept.push(...lines.slice(cursor, block.start));
    cursor = block.end;
  }
  kept.push(...lines.slice(cursor));
  return kept.join('\n').trim();
}

/** The block most likely to be the deliverable: the longest block whose
 *  language is preferred, else the longest block of any language. */
export function pickCodeBlock(text: string, prefer: readonly string[] = []): FencedBlock | null {
  const blocks = fencedBlocks(text);
  const preferred = blocks.filter((block) => prefer.includes(block.lang));
  return longest(preferred.length > 0 ? preferred : blocks);
}

function longest(blocks: readonly FencedBlock[]): FencedBlock | null {
  let best: FencedBlock | null = null;
  for (const block of blocks) {
    if (!best || block.body.trim().length > best.body.trim().length) best = block;
  }
  return best;
}

/** The HTML block a model delivered and the text before it (a doctype or a
 *  descriptor comment can sit outside the fence), or null without one: the
 *  longest html block, else the longest block whose body starts with '<'. */
export function htmlBlock(raw: string): { readonly body: string; readonly before: string } | null {
  const { answer } = splitThinking(raw);
  const blocks = fencedBlocks(answer);
  const tagged = blocks.filter((block) => block.lang === 'html' || block.lang === 'htm');
  const block = longest(tagged.length > 0 ? tagged : blocks.filter((candidate) => /^\s*</.test(candidate.body)));
  if (!block) return null;
  return { body: block.body.trim(), before: answer.split(/\r?\n/).slice(0, block.start).join('\n') };
}

/** The code a model meant to deliver: reasoning removed, the chosen block's
 *  body (or the whole answer when it has no fence). Leading blank lines and
 *  trailing whitespace go; first-line indentation stays (ASCII art). */
export function answerCode(raw: string, prefer: readonly string[] = []): string {
  const { answer } = splitThinking(raw);
  const block = pickCodeBlock(answer, prefer);
  return tidy(block ? block.body : answer);
}

/** The JSON text a model meant to deliver: a json (or any) block, then the
 *  balanced value inside it. That is the array when the text starts with '[',
 *  else the first object, else the first array; prose around it goes. An
 *  unbalanced value runs to the end so the parser reports the real error. */
export function answerJson(raw: string): string {
  const { answer } = splitThinking(raw);
  const block = pickCodeBlock(answer, ['json', 'jsonc', 'json5']);
  const text = (block ? block.body : answer).trim();
  let start = text.startsWith('[') ? 0 : text.indexOf('{');
  if (start === -1) start = text.indexOf('[');
  if (start === -1) return text;
  return text.slice(start, jsonValueEnd(text, start));
}

/** One past the bracket that closes the value opened at start, skipping
 *  brackets inside strings; text.length when it never closes. */
function jsonValueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function dropLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '');
}

function tidy(text: string): string {
  return dropLeadingBlankLines(text).trimEnd();
}
