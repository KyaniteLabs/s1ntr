import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditWave7Artifacts } from '../../../src/runtime-core/Wave7LeakAudit.js';

const roots: string[] = [];
function fixture(content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wave7-leak-'));
  roots.push(root);
  const file = path.join(root, 'receipt.json');
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('Wave7LeakAudit', () => {
  it('passes sanitized release evidence', () => {
    expect(auditWave7Artifacts([fixture(JSON.stringify({ path: '$HOME/project', key: '[REDACTED]' }))])).toEqual({
      passed: true, filesScanned: 1, findings: [],
    });
  });

  it.each([
    'token-effectiveness context',
    'capture-key-id-untrusted',
    'apiKey: overrides?.apiKey',
    'readonly secret: Uint8Array',
    '/Users/<user>/work/repo',
  ])('does not confuse source vocabulary with a leak: %s', content => {
    expect(auditWave7Artifacts([fixture(content)]).findings).toEqual([]);
  });

  it.each([
    ['credential', 'sk-example1234567890'],
    ['key credential', 'key-privatevalue123'],
    ['token credential', 'token-privatevalue123'],
    ['authorization', 'Authorization: Bearer-private-value'],
    ['quoted secret', 'apiKey: "private-value-123"'],
    ['unquoted api key', 'API_KEY=long-secret'],
    ['unquoted secret', 'secret: long-secret'],
    ['all-letter plaintext', 'password=supersecret'],
    ['private path', '/Users/privateperson/work/repo'],
    ['email', 'private.person@example.com'],
  ])('fails on %s', (_label, content) => {
    const result = auditWave7Artifacts([fixture(content)]);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
  });
});
