import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const renovate = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'renovate.json'), 'utf8'),
) as {
  automerge: boolean;
  lockFileMaintenance: { enabled: boolean; schedule: string[] };
  packageRules: Array<Record<string, unknown>>;
};
const workflow = fs.readFileSync(
  path.join(repoRoot, '.forgejo/workflows/ci.yml'),
  'utf8',
);

describe('Renovate and Forgejo dependency policy', () => {
  it('keeps weekly lock maintenance separate from ordinary dependency updates', () => {
    expect(renovate.automerge).toBe(false);
    expect(renovate.lockFileMaintenance).toEqual({
      enabled: true,
      schedule: ['before 4am on monday'],
    });
  });

  it('groups the exact Babel toolchain and gates every npm major', () => {
    expect(renovate.packageRules).toContainEqual(expect.objectContaining({
      matchManagers: ['npm'],
      matchPackageNames: [
        '@babel/parser',
        '@babel/traverse',
        '@babel/types',
        '@types/babel__traverse',
      ],
      groupName: 'Babel toolchain',
    }));
    expect(renovate.packageRules).toContainEqual(expect.objectContaining({
      matchManagers: ['npm'],
      matchUpdateTypes: ['major'],
      dependencyDashboardApproval: true,
    }));
  });

  it.each([['cookie', '<2'], ['eslint', '<10'], ['ink', '<7']])(
    'holds %s at %s',
    (packageName, allowedVersions) => {
      expect(renovate.packageRules).toContainEqual(expect.objectContaining({
        matchPackageNames: [packageName],
        allowedVersions,
      }));
    },
  );

  it('activates packageManager exactly and enforces the frozen lockfile', () => {
    expect(workflow).toContain(
      'PACKAGE_MANAGER=$(node -p "require(\'./package.json\').packageManager")',
    );
    expect(workflow).toContain('corepack prepare "$PACKAGE_MANAGER" --activate');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).not.toContain('pnpm install --no-frozen-lockfile');
  });
});
