/* eslint-disable no-console -- CLI command output: console output is intentional */
/**
 * FieldCli — the `sinter field` command surface for the Latent Field organ.
 * `sinter field frontier` reports the adjacent possible.
 * `sinter field interpolate <a> <b> [α]` generates a hybrid child.
 */
import { emptyRegions, interpolate, type InterpIO } from '../atelier/LatentField.js';

export async function runFieldCommand(cmdArgs: string[]): Promise<void> {
  const cwd = process.cwd();

  if (cmdArgs[0] === 'frontier' || cmdArgs.length === 0) {
    const frontier = emptyRegions(cwd);
    if (frontier.length === 0) {
      console.log('[field] no empty regions — board too thin to steer (fewer than 2 latent beads); it fills as waves complete');
    } else {
      console.log(`[field] ${frontier.length} frontier entries (adjacent possible):`);
      for (const f of frontier.slice(0, 8)) {
        console.log(`[field]   ${f.domainA} × ${f.domainB} (min quality ${f.minQuality.toFixed(2)}) -> interpolate ${f.beadA} ${f.beadB} 0.5`);
      }
    }
    return;
  }

  if (cmdArgs[0] === 'interpolate') {
    const a = cmdArgs[1];
    const b = cmdArgs[2];
    const alpha = cmdArgs[3] ? Number(cmdArgs[3]) : 0.5;
    if (!a || !b) {
      console.error('usage: sinter field interpolate <beadA> <beadB> [alpha]');
      process.exit(1);
    }
    // Generator transport: the standard spine path
    const io: InterpIO = {
      generate: async (prompt: string) => {
        const { execFileSync } = await import('node:child_process');
        try {
          const out = execFileSync('node', ['bin/sinter', prompt], {
            cwd, timeout: 300000, encoding: 'utf8',
          });
          const dir = out.match(/Saved: (\S+)/)?.[1]?.replace('/source.txt', '');
          if (!dir) return null;
          const source = execFileSync('cat', [`${dir}/source.txt`], { encoding: 'utf8' });
          return { source, artifactDir: dir };
        } catch { return null; }
      },
    };
    const child = await interpolate(cwd, a, b, alpha, io);
    if (child) {
      console.log(`[field] HYBRID BORN: ${child.id} (${child.domain}) at α=${alpha} from ${a} × ${b}`);
      console.log(`[field]   dir: ${child.dir}`);
    } else {
      console.log('[field] interpolation failed — beads not found, field not built, or generation failed');
    }
    return;
  }

  console.error('usage: sinter field [frontier|interpolate <a> <b> [alpha]]');
  process.exit(1);
}
