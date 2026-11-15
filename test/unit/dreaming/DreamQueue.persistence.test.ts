import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DreamQueue, type DreamTask } from '../../../src/dreaming/DreamQueue.js';

describe('DreamQueue persistence', () => {
  let dir: string;
  let queueFile: string;

  const sources: DreamTask['sources'] = [
    { id: 'art-a', descriptor: [0.2, 0.8, 0.5], quality: 0.9 },
    { id: 'art-b', descriptor: [0.7, 0.1, 0.4], quality: 0.75 },
  ];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dreamq-'));
    queueFile = path.join(dir, 'dreams', 'queue.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an enqueued task to a fresh instance on the same path', () => {
    const writer = new DreamQueue({ persistPath: queueFile });
    const id = writer.enqueue('elite-x-elite', sources, 0.8);
    expect(typeof id).toBe('string');

    const reader = new DreamQueue({ persistPath: queueFile });
    const tasks = reader.getTasks('queued');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(id);
    expect(tasks[0].strategy).toBe('elite-x-elite');
    expect(tasks[0].priority).toBe(0.8);
    expect(tasks[0].sources).toEqual(sources);
  });

  it('reclaims a persisted running task back to queued (consumer crash recovery)', () => {
    const writer = new DreamQueue({ persistPath: queueFile });
    const id = writer.enqueue('cross-modal', sources, 0.5);
    const running = writer.dequeue();
    expect(running?.id).toBe(id);
    expect(running?.status).toBe('running');

    // Simulate the consumer process dying: a fresh instance must see it queued again.
    const reader = new DreamQueue({ persistPath: queueFile });
    expect(reader.getStatus()).toEqual({ queued: 1, running: 0, completed: 0, failed: 0 });
    expect(reader.dequeue()?.id).toBe(id);
  });

  it('persists completion with its result across instances', () => {
    const writer = new DreamQueue({ persistPath: queueFile });
    const id = writer.enqueue('elite-x-compost', sources, 0.6)!;
    writer.dequeue();
    writer.complete(id, { candidateDescriptor: [0.45, 0.45, 0.45], parentIds: ['art-a', 'art-b'] });

    const reader = new DreamQueue({ persistPath: queueFile });
    const done = reader.getTasks('completed');
    expect(done).toHaveLength(1);
    expect(done[0].result).toEqual({ candidateDescriptor: [0.45, 0.45, 0.45], parentIds: ['art-a', 'art-b'] });
  });

  it('continues task ids from the persisted counter instead of colliding', () => {
    const writer = new DreamQueue({ persistPath: queueFile });
    const firstId = writer.enqueue('elite-x-elite', sources, 0.4)!;

    const reader = new DreamQueue({ persistPath: queueFile });
    const secondId = reader.enqueue('cross-modal', sources, 0.9)!;
    expect(secondId).not.toBe(firstId);
    const firstNum = Number(/^dream-(\d+)-/.exec(firstId)![1]);
    const secondNum = Number(/^dream-(\d+)-/.exec(secondId)![1]);
    expect(secondNum).toBe(firstNum + 1);
  });

  it('persists automatic terminal-task pruning across reloads', () => {
    const writer = new DreamQueue({ persistPath: queueFile, maxConcurrent: 1, maxQueueSize: 2 });
    const completedId = writer.enqueue('elite-x-elite', sources, 0.9)!;
    const queuedId = writer.enqueue('cross-modal', sources, 0.8)!;
    writer.dequeue();
    writer.complete(completedId, { candidateDescriptor: [], parentIds: [] });

    const newId = writer.enqueue('elite-x-compost', sources, 0.7);

    expect(newId).toMatch(/^dream-/);
    const reader = new DreamQueue({ persistPath: queueFile, maxQueueSize: 2 });
    expect(reader.getTasks().map((task) => task.id)).toEqual([queuedId, newId]);
    expect(reader.getStatus()).toEqual({ queued: 2, running: 0, completed: 0, failed: 0 });
  });

  it('persists stale queued-task eviction and its replacement', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const writer = new DreamQueue({ persistPath: queueFile, maxQueueSize: 2 });
    const evictedId = writer.enqueue('cross-modal', sources, 0.2)!;
    const retainedId = writer.enqueue('elite-x-elite', sources, 0.8)!;
    vi.setSystemTime(new Date('2026-07-15T00:00:01Z'));

    const replacementId = writer.enqueue('elite-x-compost', sources, 0.5)!;
    const reader = new DreamQueue({ persistPath: queueFile, maxQueueSize: 2 });
    const ids = reader.getTasks().map(task => task.id);

    expect(ids).toEqual([retainedId, replacementId]);
    expect(ids).not.toContain(evictedId);
  });

  it('quarantines a corrupt queue file instead of overwriting it', () => {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, '{not valid json', 'utf-8');

    const queue = new DreamQueue({ persistPath: queueFile });
    expect(queue.getTasks()).toHaveLength(0);

    // The unreadable original must survive as a quarantined copy.
    const siblings = fs.readdirSync(path.dirname(queueFile));
    const quarantined = siblings.find((f) => f.startsWith('queue.json.corrupt-'));
    expect(quarantined).toMatch(/^queue\.json\.corrupt-\d+$/);
    expect(fs.readFileSync(path.join(path.dirname(queueFile), quarantined!), 'utf-8')).toBe('{not valid json');

    // And new writes go to a clean file without touching the quarantine.
    queue.enqueue('elite-x-elite', sources, 0.3);
    const saved = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
    expect(saved.tasks).toHaveLength(1);
  });

  it('stays purely in-memory when persistPath is not set', () => {
    const queue = new DreamQueue();
    queue.enqueue('elite-x-elite', sources, 0.7);
    expect(fs.existsSync(queueFile)).toBe(false);
    expect(queue.getStatus().queued).toBe(1);
  });

  it('migrates persisted pre-W5-07 tasks into the artifact lane', () => {
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, JSON.stringify({
      version: 1,
      tasks: [{
        id: 'dream-7-1',
        strategy: 'elite-x-elite',
        sources,
        priority: 0.8,
        status: 'queued',
        enqueuedAt: '2026-07-30T00:00:00.000Z',
      }],
    }));
    const queue = new DreamQueue({ persistPath: queueFile });

    expect(queue.getTasks()[0].kind).toBe('artifact');
    expect(queue.dequeue()?.id).toBe('dream-7-1');
  });
});
