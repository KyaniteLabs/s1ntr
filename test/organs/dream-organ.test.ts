/**
 * Organ: dream (DreamPlanner + DreamQueue). The admitted-source -> activation flow is proven by
 * test/integration/dream-transfer-activation-product.test.ts; this organ test pins the two seams that
 * decide whether dreaming is connected: the planner fails closed on unadmitted archive entries, and the
 * queue survives a process boundary (gardener enqueues, self-improve consumes) with crashed work reclaimed.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DreamPlanner } from '../../src/dreaming/DreamPlanner.js';
import { DreamQueue } from '../../src/dreaming/DreamQueue.js';

const dirs: string[] = [];
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'organ-dream-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
const src = (id: string) => [{ id, descriptor: [0.1], quality: 0.8 }];

describe('organ: dream', () => {
  it('planner proposes nothing from entries that carry no source admission', () => {
    const entry = (id: string) => ({ id, qualityScore: 0.9, descriptor: { values: [{ axis: 'order-chaos', value: 0.2 }], source: 't', extractedAt: 'n' } });
    const cells = ['a', 'b', 'c'].map(id => ({ cellId: id, coordinates: [], nearElites: [], elite: entry(id) }));
    expect(new DreamPlanner().plan(cells as never, [])).toEqual({ tasks: [] });
  });

  it('queue persists across instances, orders by priority, and reclaims a crashed running task', async () => {
    const file = path.join(await tmp(), 'dream-queue.json');
    const producer = new DreamQueue({ persistPath: file });
    producer.enqueue('elite-x-elite', src('lo'), 0.2);
    const hi = producer.enqueue('elite-x-elite', src('hi'), 0.9)!;
    const consumer = new DreamQueue({ persistPath: file });
    const first = consumer.dequeue();
    expect(first?.id).toBe(hi);
    const afterCrash = new DreamQueue({ persistPath: file });   // consumer died mid-dream
    expect(afterCrash.getTasks('queued').map(t => t.id)).toContain(hi);
    expect(afterCrash.dequeue()?.id).toBe(hi);                 // reclaimed work is runnable again
    afterCrash.complete(hi, { candidateDescriptor: [0.5], parentIds: ['hi'] });
    expect(new DreamQueue({ persistPath: file }).getTasks('completed')).toHaveLength(1);
  });

  it('a corrupt queue file is quarantined, never overwritten', async () => {
    const d = await tmp(); const file = path.join(d, 'q.json');
    const { writeFileSync, readdirSync } = await import('node:fs');
    writeFileSync(file, '{not json');
    new DreamQueue({ persistPath: file }).enqueue('elite-x-elite', src('x'), 0.5);
    expect(readdirSync(d).some(n => n.startsWith('q.json.corrupt-'))).toBe(true);
  });
});
