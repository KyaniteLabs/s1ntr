/**
 * Gate: every product command that can call a provider opens a receipted product grant the same way `generate` does.
 * A file that builds a provider client or drives a provider-backed run without any grant call fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const GRANT = /runProductionCli(?:ProviderEffect|CycleEffect|Generate|Compose)|runResearchProviderEffect/;

// Files that reach a provider from a CLI entry. Authoritative create/reevaluate carry their own signed authority file.
const PROVIDER_CALLING = [
  'bin/sinter', 'src/cli/LiminalProductionCompose.ts', 'src/cli/ReverseCli.ts', 'src/cli/SwarmCli.ts',
  'src/cli/SiteCommand.ts', 'src/cli/HillClimbLive.ts', 'src/ledger/cli.ts', 'src/chat/commands/chatReflect.ts',
];
const OWN_AUTHORITY = ['src/cli/LiminalAuthoritativeCreate.ts'];

describe('authority gate: provider-calling commands open a product grant', () => {
  it.each(PROVIDER_CALLING)('%s opens a grant', (file) => { expect(read(file)).toMatch(GRANT); });

  it.each([
    ['site evolve', 'src/cli/SiteCommand.ts', 'runProductionCliCycleEffect'],
    ['ledger run', 'src/ledger/cli.ts', 'runProductionCliCycleEffect'],
    ['swarm run', 'src/cli/SwarmCli.ts', 'runProductionCliProviderEffect'],
    ['judgment compare', 'bin/sinter', 'judgment-compare'],
    ['judgment compare evaluator call', 'src/learning/RenderedJudgmentComparison.ts', 'evaluatorCall'],
    ['compose --spec', 'bin/sinter', 'production-compose-spec'],
  ])('%s is wrapped by its grant', (_name, file, token) => { expect(read(file)).toContain(token); });

  it('binds rendered comparison to the evaluator role inside its cycle grant', () => {
    const dispatch = read('bin/sinter').split("cmd === 'judgment' && cmdArgs[0] === 'compare'")[1].split("process.exit(0)")[0];
    expect(dispatch).toContain("new LLMClient({ role: 'evaluator' })");
    expect(dispatch).toContain('effect: () => compareRenderedJudgment(candidates, evaluator)');
  });

  it('no other CLI file that builds a provider client or drives a run is missing a grant', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    const offenders = readdirSync(path.join(root, 'src/cli')).filter(f => f.endsWith('.ts'))
      .map(f => `src/cli/${f}`)
      .filter(f => !OWN_AUTHORITY.includes(f) && !PROVIDER_CALLING.includes(f))
      .filter(f => /new LLMClient\(|\.compose\(|orchestrator\.run\(|\.runCycle\(|runner\.runTask\(/.test(read(f)) && !GRANT.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
