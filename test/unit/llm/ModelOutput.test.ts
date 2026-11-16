import { describe, expect, it } from 'vitest';
import { answerCode, answerJson, fencedBlocks, hasThinkTags, htmlBlock, proseOutsideFences, splitThinking } from '../../../src/llm/ModelOutput.js';

describe('splitThinking', () => {
  it('passes a reply without reasoning through verbatim', () => {
    expect(splitThinking('\n  x = 1\n  ')).toEqual({ thinking: '', answer: '\n  x = 1\n  ', thinkClosed: true });
  });

  it('separates closed blocks of every tag spelling', () => {
    const reply = splitThinking('<think>a</think>one <thinking>b</thinking>two <thinkContent>c</thinkContent>');
    expect(reply).toEqual({ thinking: 'a\n\nb\n\nc', answer: 'one two ', thinkClosed: true });
  });

  it('treats an unclosed block as reasoning with no answer yet', () => {
    expect(splitThinking('<think>still going')).toEqual({ thinking: 'still going', answer: '', thinkClosed: false });
  });

  it('treats text before an orphan close as reasoning', () => {
    expect(splitThinking('plan\n</think>\ncode()')).toEqual({ thinking: 'plan', answer: 'code()', thinkClosed: true });
  });

  it('keeps nested tags inside one block', () => {
    expect(splitThinking('<think>a <think>b</think> c</think>ok').answer).toBe('ok');
  });

  it('does not read a tag with a bare < inside it as a tag', () => {
    const raw = '<think hmm let me reason</thinkosc(10)>\ns("bd sd")';
    expect(splitThinking(raw)).toEqual({ thinking: '', answer: raw, thinkClosed: true });
  });

  it('detects tags without consuming state between calls', () => {
    expect(hasThinkTags('<think>x</think>')).toBe(true);
    expect(hasThinkTags('<think>x</think>')).toBe(true);
    expect(hasThinkTags('const think = 1;')).toBe(false);
  });

  it('splits correctly right after a tag check on the same text', () => {
    const raw = 'plan</think>fill(0);';
    expect(hasThinkTags(raw)).toBe(true);
    expect(splitThinking(raw).answer).toBe('fill(0);');
  });
});

describe('fencedBlocks', () => {
  it('reads language, body and closure', () => {
    expect(fencedBlocks('a\n```JavaScript extra\nx\n```\nb\n~~~py\ny')).toEqual([
      { lang: 'javascript', start: 1, end: 4, body: 'x', closed: true },
      { lang: 'py', start: 5, end: 7, body: 'y', closed: false },
    ]);
  });

  it('needs a closing fence of the same character and at least the same length', () => {
    expect(fencedBlocks('````md\n```js\nx\n```\n````')).toEqual([
      { lang: 'md', start: 0, end: 5, body: '```js\nx\n```', closed: true },
    ]);
    expect(fencedBlocks('~~~md\nx\n```\n~~~')[0].body).toBe('x\n```');
  });

  it('reads a bare tilde row as artwork, not a fence', () => {
    expect(fencedBlocks('  /\\\n/____\\\n~~~~~~')).toEqual([]);
    expect(answerCode('~~~\n /\\\n~~~')).toBe('~~~\n /\\\n~~~');
  });

  it('reads tilde rows that only look like fences as artwork', () => {
    expect(fencedBlocks('~~~ * ~~~\n /\\\n~~~ ~~~ ~~~')).toEqual([]);
    expect(answerCode('~~~ * ~~~\n /\\\n~~~ ~~~ ~~~')).toBe('~~~ * ~~~\n /\\\n~~~ ~~~ ~~~');
  });

  it('reads a long bare backtick run that never closes as artwork', () => {
    expect(answerCode('  /\\\n /  \\\n``````')).toBe('  /\\\n /  \\\n``````');
  });

  it('ignores a stray trailing fence after unfenced code', () => {
    expect(answerCode('osc(10).out()\n```')).toBe('osc(10).out()\n```');
  });

  it('reads a fence opened and closed on one line', () => {
    expect(fencedBlocks('```hello```world')).toEqual([{ lang: '', start: 0, end: 1, body: 'hello', closed: true }]);
    expect(answerCode('Use this: \n```x = 1;```')).toBe('x = 1;');
  });

  it('keeps inner whitespace verbatim', () => {
    expect(fencedBlocks('```\n  /\\\n /  \\\n```')[0].body).toBe('  /\\\n /  \\');
  });

  it('ignores inline backticks', () => {
    expect(fencedBlocks('use ``` to fence, or `x`')).toEqual([]);
  });

  it('does not close on a template literal ending in a backtick', () => {
    expect(fencedBlocks('```js\nconst s = `a`;\n```')[0].body).toBe('const s = `a`;');
  });
});

describe('proseOutsideFences', () => {
  it('keeps the words around the code', () => {
    expect(proseOutsideFences('Here:\n```js\nx\n```\nEnjoy.')).toBe('Here:\nEnjoy.');
  });
});

describe('answerCode', () => {
  it('prefers the requested language, then the longest block', () => {
    const raw = '```bash\nnpm i\n```\n```glsl\nvoid main(){}\n```\n```js\nlet a = 1; let b = 2;\n```';
    expect(answerCode(raw, ['glsl'])).toBe('void main(){}');
    expect(answerCode(raw)).toBe('let a = 1; let b = 2;');
  });

  it('returns the answer itself when there is no fence', () => {
    expect(answerCode('<think>x</think>\n\n  osc(10).out()\n')).toBe('  osc(10).out()');
  });

  it('returns nothing when the reply never left its reasoning', () => {
    expect(answerCode('<think>```js\nfoo()\n```')).toBe('');
  });
});

describe('answerJson', () => {
  it('reads a json block, a bare object, or one wrapped in prose', () => {
    expect(answerJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(answerJson('<think>{no}</think>{"a":1}')).toBe('{"a":1}');
    expect(answerJson('Sure! {"a":[1]} hope that helps')).toBe('{"a":[1]}');
    expect(answerJson('list: [1, 2]')).toBe('[1, 2]');
  });

  it('cuts at the bracket that closes the value, not the last one in the text', () => {
    expect(answerJson('Items [3]: {"a":1}')).toBe('{"a":1}');
    expect(answerJson('{"a":[1]} note [x]')).toBe('{"a":[1]}');
    expect(answerJson('{"a":1}\nAlso {"b":2}')).toBe('{"a":1}');
    expect(answerJson('[{"a":1}] trailing ]')).toBe('[{"a":1}]');
  });

  it('skips brackets inside strings', () => {
    expect(answerJson('{"s":"} ] \\" {"} done')).toBe('{"s":"} ] \\" {"}');
  });

  it('leaves an unbalanced value to the parser', () => {
    expect(answerJson('{"a": [1, 2')).toBe('{"a": [1, 2');
  });
});

describe('htmlBlock', () => {
  it('prefers an html block over a longer css block', () => {
    const raw = 'Doc:\n```css\nbody { margin: 0; padding: 0; color: red; }\n```\n```html\n<p>x</p>\n```';
    expect(htmlBlock(raw)?.body).toBe('<p>x</p>');
  });

  it('takes an untagged block that starts with a tag and ignores the rest', () => {
    const raw = '```js\nconst aVeryLongScriptBodyThatIsLongerThanTheMarkup = 1;\n```\n```\n<div></div>\n```';
    expect(htmlBlock(raw)?.body).toBe('<div></div>');
    expect(htmlBlock('```js\nx()\n```')).toBeNull();
  });
});
