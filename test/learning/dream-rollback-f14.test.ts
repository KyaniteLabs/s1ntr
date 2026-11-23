/** F14: activate two snapshots, roll the newest back from the PUBLIC CLI, restart (fresh process), and the next brief teaches only the previous lesson. */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileActivatedKnowledgeStore } from '../../src/dreaming/research/DreamKnowledgeActivation.js';
import { isolatedCliEnv } from '../helpers/isolatedCli.js';

const cli = path.resolve(__dirname, '../../bin/sinter');
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64);
let dir = '';
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const run = (...a: string[]) => spawnSync('node', [cli, ...a], { encoding: 'utf8', env: isolatedCliEnv({ SINTER_LIMINAL_KNOWLEDGE_ROOT: dir }).env });

describe('governed rollback surface', () => {
  it('rolls back the newest snapshot; a new process sees the previous one as latest', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
    fs.writeFileSync(path.join(dir, 'activated-knowledge.json'), JSON.stringify({ schema: 'sinter.activated-creative-knowledge-store', schemaVersion: 1,
      snapshots: { [D1]: { snapshotDigest: D1, scope: ['visual'] }, [D2]: { snapshotDigest: D2, scope: ['visual'] } }, rolledBack: {},
      activations: { [D1]: { sequence: 1, at: 'a' }, [D2]: { sequence: 2, at: 'b' } } }));
    const file = path.join(dir, 'activated-knowledge.json');
    expect(new FileActivatedKnowledgeStore(file).latestActive('visual')?.snapshotDigest).toBe(D2);
    expect(run('dream', 'rollback', D2).status).toBe(1);                       // a reason is mandatory
    expect(run('dream', 'rollback', 'nope', 'x').status).toBe(1);    // unknown snapshot
    const ok = run('dream', 'rollback', D2, 'bad', 'lesson');
    expect(ok.status, ok.stderr).toBe(0);
    expect(new FileActivatedKnowledgeStore(file).latestActive('visual')?.snapshotDigest).toBe(D1);
  });
});
