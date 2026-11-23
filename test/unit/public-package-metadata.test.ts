import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The npm page and the public mirror are the first things a new user sees.
// Every URL they show must resolve publicly, and every relative README link
// must point at a file that actually ships in the tarball (npm resolves
// relative links against `repository`, and the mirror excludes docs/).

const PUBLIC_URL = /^(git\+)?https:\/\/(github\.com\/KyaniteLabs\/s1ntr([/.#]|$)|docs\.s1ntr\.com(\/|$)|s1ntr\.com(\/|$))/;

const read = (path: string) => readFileSync(path, 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  description: string;
  homepage: string;
  repository: { url: string };
  bugs: { url: string };
  files: string[];
};

const relativeLinks = (markdown: string) =>
  [...markdown.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));

describe('public package metadata', () => {
  it('points repository, bugs and homepage at public locations', () => {
    for (const url of [pkg.repository.url, pkg.bugs.url, pkg.homepage]) {
      expect(url).toMatch(PUBLIC_URL);
    }
  });

  it('describes S1NTR in the public voice', () => {
    expect(pkg.description).toMatch(/^S1NTR\b/);
    expect(pkg.description).not.toMatch(/\bSinter\b/);
    expect(pkg.description).not.toMatch(/\bgenerat/i);
  });

  it('keeps every absolute README and CONTRIBUTING URL public or local', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md']) {
      const urls = read(file).match(/https?:\/\/[^\s)<>"'`]+/g) ?? [];
      for (const url of urls) {
        if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) continue;
        expect(`${file}: ${url}`).toMatch(new RegExp(`^${file}: ${PUBLIC_URL.source.slice(1)}`));
      }
    }
  });

  it('only links README files that ship in the npm tarball', () => {
    const shipped = (target: string) => {
      const path = target.replace(/^\.\//, '');
      return existsSync(path) && pkg.files.some((entry) => !entry.startsWith('!') && (path === entry || path.startsWith(`${entry}/`)));
    };
    const broken = relativeLinks(read('README.md')).filter((target) => !shipped(target));
    expect(broken).toEqual([]);
  });

  // #1595: puppeteer's install-time browser download fails on a half-filled cache and npm
  // rolls back the whole global install. The package ships a config that skips it; the
  // browser preflight installs the browser on first use instead.
  it('ships a .puppeteerrc.cjs that skips the install-time browser download', () => {
    const config = createRequire(import.meta.url)(resolve('.puppeteerrc.cjs')) as { skipDownload?: boolean };
    expect(config.skipDownload).toBe(true);
    expect(pkg.files).toContain('.puppeteerrc.cjs');
  });
});
