import { describe, it, expect } from 'vitest';
import { generateFiveVariations } from '../../src/evolution/generateFiveVariations.js';

describe('generateFiveVariations', () => {
  const validP5 = `function setup() { createCanvas(400, 400); }
function draw() { background(220); circle(200, 200, 50); }`;

  it('returns array of length 5', async () => {
    const generator = async () => validP5;
    const result = await generateFiveVariations('draw a circle', generator);
    expect(result).toHaveLength(5);
  });

  it('returns { code, fitness } for each item', async () => {
    const generator = async () => validP5;
    const result = await generateFiveVariations('draw a circle', generator);
    for (const item of result) {
      expect(item).toHaveProperty('code');
      expect(item).toHaveProperty('fitness');
      expect(typeof item.code).toBe('string');
      expect(typeof item.fitness).toBe('number');
      expect(item.fitness).toBeGreaterThanOrEqual(0);
      expect(item.fitness).toBeLessThanOrEqual(1);
    }
  });

  it('issues exactly five fixed prompt variants and carries no state between calls (#1274)', async () => {
    const seen = [];
    const generator = async (p) => { seen.push(p); return validP5; };
    await generateFiveVariations('draw a circle', generator);
    const first = [...seen];
    seen.length = 0;
    await generateFiveVariations('draw a circle', generator);
    expect(first).toEqual([
      'draw a circle',
      'draw a circle — variation 2',
      'draw a circle — variation 3',
      'draw a circle — variation 4',
      'draw a circle — variation 5',
    ]);
    expect(seen).toEqual(first);
  });

  it('propagates a generator failure instead of returning partial results', async () => {
    let n = 0;
    const generator = async () => { n += 1; if (n === 3) throw new Error('gen down'); return validP5; };
    await expect(generateFiveVariations('x', generator)).rejects.toThrow('gen down');
  });
});

