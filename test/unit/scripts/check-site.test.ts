import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script without type declarations
import { checkSite, knownCommands } from '../../../scripts/docs/check-site.mjs';

const dirs: string[] = [];
function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'site-check-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const commands = new Set(['studio', 'list']);

describe('check-site', () => {
  it('passes a clean page with known commands and working links', () => {
    const dir = site({
      'index.html': '<a href="cli.html">CLI</a><code>sinter studio</code> Sinter by KyaniteLabs',
      'cli.html': '<link href="assets/a.css"><code>sinter list</code>',
      'assets/a.css': 'body{}',
    });
    expect(checkSite(dir, commands)).toEqual([]);
  });

  it('reports every leak class with file and match', () => {
    const dir = site({
      'a.html': 'Liminal studio at /home/simon/x on nucbox 100.101.2.3 see github.com/KyaniteLabs/x',
    });
    expect(checkSite(dir, commands)).toEqual([
      'a.html: old-name "Liminal"',
      'a.html: home-path "/home/simon"',
      'a.html: tailnet-ip "100.101.2.3"',
      'a.html: private-host "nucbox"',
      'a.html: repo-link "github.com/KyaniteLabs"',
    ]);
  });

  it('flags a documented command the CLI would treat as a prompt', () => {
    const dir = site({ 'g.html': '<code>sinter tui</code> and <code>sinter studio</code>' });
    expect(checkSite(dir, commands)).toEqual([
      'g.html: unknown command "sinter tui" would run as a paid prompt',
    ]);
  });

  it('flags missing and root-absolute local links but not external ones', () => {
    const dir = site({ 'i.html': '<a href="gone.html">x</a><a href="/abs.html">y</a><a href="https://s1ntr.com/">z</a>' });
    expect(checkSite(dir, commands)).toEqual([
      'i.html: broken local link "gone.html"',
      'i.html: broken local link "/abs.html"',
    ]);
  });

  it('ignores files that are not text documents', () => {
    const dir = site({ 'img.png': 'liminal' });
    expect(checkSite(dir, commands)).toEqual([]);
  });

  it('reads the real command list from the CLI source', () => {
    const known = knownCommands();
    expect([known.has('studio'), known.has('compose'), known.has('tui')]).toEqual([true, true, false]);
  });

  it('throws when the command list cannot be found', () => {
    const root = site({ 'src/cli/PromptArgs.ts': 'export {}' });
    expect(() => knownCommands(root)).toThrow('KNOWN_COMMANDS not found');
  });
});
