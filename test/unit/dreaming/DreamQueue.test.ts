/**
 * Unit tests for DreamQueue — Phase 15
 *
 * Tests priority queue with concurrency control.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DreamQueue } from '../../../src/dreaming/DreamQueue.js';

describe('DreamQueue', () => {
  let queue: DreamQueue;

  beforeEach(() => {
    queue = new DreamQueue({ maxConcurrent: 2, maxQueueSize: 10 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enqueues and dequeues tasks by priority', () => {
    queue.enqueue('elite-x-compost', [], 0.3);
    queue.enqueue('elite-x-elite', [], 0.9);
    queue.enqueue('cross-modal', [], 0.5);

    const first = queue.dequeue();
    expect(first).toMatchObject({
      strategy: 'elite-x-elite',
      priority: 0.9,
      status: 'running',
    });
  });

  it('respects maxConcurrent limit', () => {
    queue.enqueue('elite-x-elite', [], 0.9);
    queue.enqueue('cross-modal', [], 0.7);
    queue.enqueue('elite-x-compost', [], 0.5);

    const d1 = queue.dequeue();
    const d2 = queue.dequeue();
    expect(d1).toMatchObject({ strategy: 'elite-x-elite', status: 'running' });
    expect(d2).toMatchObject({ strategy: 'cross-modal', status: 'running' });
    // Third dequeue should return undefined (maxConcurrent = 2)
    const d3 = queue.dequeue();
    expect(d3).toBeUndefined();
  });

  it('complete marks a task as completed with result', () => {
    const taskId = queue.enqueue('elite-x-elite', [], 0.9);
    const task = queue.dequeue();
    expect(task).toMatchObject({ id: taskId, status: 'running' });

    queue.complete(taskId, { candidateDescriptor: [0.5, 0.3], parentIds: ['a', 'b'] });
    const status = queue.getStatus();
    expect(status.completed).toBe(1);
    expect(status.running).toBe(0);
  });

  it('fail marks a task as failed', () => {
    const taskId = queue.enqueue('elite-x-compost', [], 0.3);
    queue.dequeue();
    queue.fail(taskId);

    const status = queue.getStatus();
    expect(status.failed).toBe(1);
  });

  it('getStatus returns queue metrics', () => {
    queue.enqueue('elite-x-elite', [], 0.9);
    queue.enqueue('cross-modal', [], 0.5);

    const status = queue.getStatus();
    expect(status.queued).toBe(2);
  });

  it('getTasks filters by status', () => {
    const t1 = queue.enqueue('elite-x-elite', [], 0.9);
    queue.dequeue();
    queue.complete(t1!, { candidateDescriptor: [], parentIds: [] });

    const completed = queue.getTasks('completed');
    expect(completed).toHaveLength(1);
  });

  it('prune removes completed and failed tasks', () => {
    const t1 = queue.enqueue('elite-x-elite', [], 0.9);
    queue.dequeue();
    queue.complete(t1!, { candidateDescriptor: [], parentIds: [] });

    const removed = queue.prune();
    expect(removed).toBe(1);
    const completed = queue.getTasks('completed');
    expect(completed).toHaveLength(0);
  });

  it('prunes terminal tasks before checking queue capacity', () => {
    const smallQueue = new DreamQueue({ maxConcurrent: 3, maxQueueSize: 4 });
    const completedId = smallQueue.enqueue('elite-x-elite', [], 0.9)!;
    const failedId = smallQueue.enqueue('cross-modal', [], 0.8)!;
    smallQueue.enqueue('elite-x-compost', [], 0.7);
    smallQueue.enqueue('cross-modal', [], 0.6);

    smallQueue.dequeue();
    smallQueue.dequeue();
    smallQueue.complete(completedId, { candidateDescriptor: [], parentIds: [] });
    smallQueue.fail(failedId);
    const running = smallQueue.dequeue();

    const newId = smallQueue.enqueue('elite-x-elite', [], 0.5);

    expect(newId).toMatch(/^dream-/);
    expect(smallQueue.getStatus()).toEqual({ queued: 2, running: 1, completed: 0, failed: 0 });
    expect(smallQueue.getTasks('running')[0].id).toBe(running!.id);
  });
  it('respects maxQueueSize', () => {
    const smallQueue = new DreamQueue({ maxConcurrent: 5, maxQueueSize: 2 });
    const t1 = smallQueue.enqueue('elite-x-elite', [], 0.9);
    const t2 = smallQueue.enqueue('cross-modal', [], 0.7);
    const t3 = smallQueue.enqueue('elite-x-compost', [], 0.3);
    expect(t3).toBeUndefined();
  });

  it('evicts only the lowest-priority stale queued task when full', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
    const smallQueue = new DreamQueue({ maxQueueSize: 3 });
    const staleHigh = smallQueue.enqueue('elite-x-elite', [], 0.9)!;
    const staleLow = smallQueue.enqueue('cross-modal', [], 0.2)!;
    vi.setSystemTime(new Date('2026-07-15T00:00:01Z'));
    const recentLow = smallQueue.enqueue('elite-x-compost', [], 0.1)!;

    const replacement = smallQueue.enqueue('distant-niche-x-distant', [], 0.5);
    const ids = smallQueue.getTasks().map(task => task.id);

    expect(replacement).toMatch(/^dream-/);
    expect(ids).toContain(staleHigh);
    expect(ids).toContain(recentLow);
    expect(ids).not.toContain(staleLow);
  });
});
