import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Asset = { id: string; version: string; license: string };

function noticeErrors(assets: Asset[], notices: string): string[] {
  const section = notices.split('## Vendored browser libraries (vendor/)\n')[1]?.split('\n## ')[0] ?? '';
  const rows = section.split('\n').filter((line) => line.startsWith('| `'));
  return assets.flatMap(({ id, version, license }) => {
    const errors: string[] = [];
    if (!license?.trim()) errors.push(`${id}@${version}: empty license`);
    const found = rows.some((row) => {
      const columns = row.split('|').map((column) => column.trim());
      return columns[1]?.split(', ').includes(`\`${id}\``) && columns[2] === `\`${version}\``;
    });
    if (!found) errors.push(`${id}@${version}: missing notice`);
    return errors;
  });
}

describe('vendored library notices', () => {
  it('covers every manifest asset and records its license', () => {
    const manifest = JSON.parse(readFileSync('vendor/manifest.json', 'utf8')) as { assets: Asset[] };
    const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
    expect(noticeErrors(manifest.assets, notices)).toEqual([]);
  });

  it('reports a missing package version and an empty license', () => {
    expect(noticeErrors([{ id: 'example', version: '1.0.0', license: ' ' }], '')).toEqual([
      'example@1.0.0: empty license',
      'example@1.0.0: missing notice',
    ]);
  });

  it('requires the asset ID and version in the same inventory row', () => {
    const notices = '## Vendored browser libraries (vendor/)\n| `example` | `2.0.0` |\n| `other` | `1.0.0` |';
    expect(noticeErrors([{ id: 'example', version: '1.0.0', license: 'MIT' }], notices))
      .toEqual(['example@1.0.0: missing notice']);
  });
});
