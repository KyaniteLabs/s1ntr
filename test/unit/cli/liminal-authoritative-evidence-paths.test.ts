import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authoritativeEvidencePaths, buildAuthoritativeReviewHtml,
  type Wave8C0AuthorityPackage } from
  '../../../src/cli/LiminalAuthoritativeCreate.js';

const authority = { schema: 'sinter.wave8-c0-authority', schemaVersion: 1,
  canonicalMainSha: 'a'.repeat(40), sourceHeadSha: 'b'.repeat(40), mainFrozen: true,
  activeBlocker: 'one-rendered-c0', prompt: 'Rendered <depth>', domains: ['p5'],
  layers: ['field', 'light'], maxTransportAttempts: 2, evalMode: 'strict-browser',
  renderer: { identity: 'renderer/v1', authorization: 'isolated-playwright' },
  roles: { generator: { executor: 'g', provider: 'fake', baseUrl: 'local', model: 'g' },
    evaluator: { executor: 'e', provider: 'fake', baseUrl: 'local', model: 'e' },
    harness: 'h', studio: 's' }, outputRoot: '/tmp/c0' } as Wave8C0AuthorityPackage;

describe('authoritative rendered evidence consumers', () => {
  it('derives review and reevaluation frames from the persisted operation directory', () => {
    const operationId = 'operation:exact';
    const directory = createHash('sha256').update(operationId).digest('hex');
    const paths = authoritativeEvidencePaths(authority.outputRoot, operationId);
    expect(paths.earlyFramePath).toBe(path.join('/tmp/c0', 'artifacts', directory,
      'early-frame.png'));
    expect(paths.lateFramePath).toBe(path.join('/tmp/c0', 'artifacts', directory,
      'late-frame.png'));
    const html = buildAuthoritativeReviewHtml(authority,
      path.join('/tmp/c0', 'artifacts', directory, 'playable.html'),
      paths.earlyFramePath, paths.lateFramePath);
    expect(html).toContain(`artifacts/${directory}/early-frame.png`);
    expect(html).toContain(`artifacts/${directory}/late-frame.png`);
    expect(html).toContain('Rendered &lt;depth&gt;');
  });

  it('contains no obsolete shared rendered-evidence consumer path', async () => {
    const source = await readFile(path.join(process.cwd(), 'src', 'cli',
      'LiminalAuthoritativeCreate.ts'), 'utf8');
    expect(source).not.toMatch(/rendered-evidence\/(early|late)\.png/);
  });
});
