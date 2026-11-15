import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function readBinFile(): string {
  return readFileSync(resolve(repoRoot, 'bin/sinter'), 'utf8');
}

describe('chat surface truth — liminal chat retirement', () => {
  it('README does not describe liminal chat as an interactive chat surface', () => {
    const readme = readRepoFile('README.md');

    // The interactive panel is retired; the living surface is studio.
    // The remaining `sinter chat` reference is `sinter chat reflect` (the working
    // non-interactive subcommand). Standalone `sinter chat` must not appear.
    const lines = readme.split('\n');
    const standaloneChatLine = lines.find((l) => /^\s*sinter chat\s*$/.test(l.trim()));
    expect(standaloneChatLine).toBeUndefined();
  });

  it('USER_SURFACE_CONTRACT does not describe liminal chat as the user surface', () => {
    const doc = readRepoFile('docs/USER_SURFACE_CONTRACT.md');

    // The contract already correctly names Studio GUI as the one invested surface.
    // It must not reference liminal chat as interactive.
    expect(doc).not.toMatch(/liminal chat.*interactive/is);
    expect(doc).not.toMatch(/`liminal chat`.*back-and-forth/is);
    expect(doc).not.toMatch(/# chat.*surface/is);
  });

  it('bin/sinter help text for chat mentions studio', () => {
    const bin = readBinFile();

    // The help line for `chat` must point users to studio.
    expect(bin).toMatch(/console\.log\('  chat\s+.*sinter studio/);
  });

  it('bin/sinter chat handler prints deprecation notice pointing to studio and exits 0', () => {
    const bin = readBinFile();

    // The deprecation block must be present.
    expect(bin).toMatch(/liminal chat is retired/);
    expect(bin).toMatch(/liminal studio/);
    expect(bin).toMatch(/process\.exit\(0\)/);

    // It must NOT call chatCommand.
    const chatHandlerBlock = bin.match(/else if \(cmd === 'chat'\) \{[\s\S]*?\n\}/);
    expect(chatHandlerBlock?.[0]).not.toMatch(/chatCommand/);
  });

  it('chat reflect path is still wired in bin/sinter', () => {
    const bin = readBinFile();

    // The reflect subcommand must remain functional (handled before the generic chat block).
    expect(bin).toMatch(/cmd === 'chat' && cmdArgs\[0\] === 'reflect'/);
    expect(bin).toMatch(/StudioReflection|studio reflection/);
  });

  it('bin/sinter no longer imports chat/commands/chat.js', () => {
    const bin = readBinFile();

    // The orphaned import was removed when chatCommand handler was retired.
    expect(bin).not.toMatch(/chat\/commands\/chat\.js/);
  });
});
