import { describe, expect, it } from 'vitest';
import { sanitizeOutput } from '../../../src/llm/LLMClient.js';
import { stripFence } from '../../../src/core/recovery/SourceRecovery.js';
import { stripModelScaffolding } from '../../../src/runtime-core/LiminalProductionEffects.js';
import { extractCodeContent } from '../../../src/tui-bridge/service/StreamHandlers.js';

const CODE = 'function draw() {\n  circle(1, 2, 3);\n}';

const shapes: Record<string, string> = {
  'plain fence': '```js\n' + CODE + '\n```',
  'dotted tag': '```p5.js\n' + CODE + '\n```',
  'space before tag': '``` javascript\n' + CODE + '\n```',
  'tsx tag': 'Here you go:\n```tsx\n' + CODE + '\n```\nEnjoy.',
  'CRLF': ('```js\n' + CODE + '\n```').replace(/\n/g, '\r\n'),
  'tilde fence': '~~~js\n' + CODE + '\n~~~',
  'four backticks': '````js\n' + CODE + '\n````',
  'unclosed fence': '```js\n' + CODE,
  'close glued to code': '```js\n' + CODE + '```',
  'closed think': '<think>plan the circle</think>\n```js\n' + CODE + '\n```',
  'thinking tag': '<thinking>plan</thinking>\n' + CODE,
  'orphan close think': 'plan the circle\n</think>\n\n```js\n' + CODE + '\n```',
  'think with fence inside': '<think>maybe ```js\nfoo()\n```</think>\n```js\n' + CODE + '\n```',
  'prose then two blocks': 'Install:\n```bash\nnpm i p5\n```\nSketch:\n```javascript\n' + CODE + '\n```',
};

const entryPoints: Record<string, (raw: string) => string | null> = {
  sanitizeOutput: (raw) => sanitizeOutput(raw).code,
  'stripFence(stripModelScaffolding)': (raw) => stripFence(stripModelScaffolding(raw)),
  extractCodeContent: (raw) => extractCodeContent({} as never, raw),
};

describe('every code entry point reads every reply shape the same way', () => {
  for (const [entry, extract] of Object.entries(entryPoints)) {
    for (const [shape, raw] of Object.entries(shapes)) {
      it(`${entry}: ${shape}`, () => {
        expect(extract(raw)?.trim()).toBe(CODE);
      });
    }
  }
});
