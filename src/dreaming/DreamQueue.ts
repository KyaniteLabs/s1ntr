/**
 * DreamQueue — Phase 15
 *
 * Manages a queue of dream tasks for off-policy recombination.
 * Dreams run as a distinct loop type — not regular generation requests.
 * Each dream task specifies a strategy, source artifacts, and priority.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../utils/Logger.js';
import { isEnoent } from '../utils/errors.js';
import type {
  CompositionDreamPlan,
  CompositionDreamRecord,
  DreamFailureRecord,
} from './CompositionDreamTypes.js';
import type { DomainType } from '../composition/types.js';

export type DreamStrategy =
  | 'elite-x-elite'
  | 'elite-x-compost'
  | 'distant-niche-x-distant'
  | 'cross-modal';

export type DreamTaskKind = 'artifact' | 'composition';

export interface DreamTask {
  id: string;
  kind: DreamTaskKind;
  strategy: DreamStrategy;
  /** Source artifacts for recombination */
  sources: Array<{
    id: string;
    descriptor: number[];
    quality: number;
    /** Exact source payload required by the governed production consumer. */
    artifact?: { domain: DomainType; prompt: string; code: string };
  }>;
  priority: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result?: {
    candidateDescriptor: number[];
    parentIds: string[];
    composition?: CompositionDreamRecord;
    failure?: DreamFailureRecord;
  };
  compositionPlan?: CompositionDreamPlan;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DreamQueueConfig {
  /** Maximum concurrent dream tasks (default: 3) */
  maxConcurrent?: number;
  /** Maximum queue size (default: 50) */
  maxQueueSize?: number;
  /**
   * Optional JSON file backing the queue. When set, the queue loads existing
   * tasks on construction and saves after every mutation, so dreams survive
   * process exit — the gardener (garden tend) enqueues in one process and the
   * self-improve cycle consumes in another. Without it the queue stays
   * in-memory, exactly as before.
   */
  persistPath?: string;
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_QUEUE = 50;
const STALE_QUEUED_TASK_MS = 14 * 24 * 60 * 60 * 1000;

export class DreamQueue {
  private readonly queue: DreamTask[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private readonly persistPath?: string;
  private runningCount = 0;
  private taskIdCounter = 0;

  constructor(config: DreamQueueConfig = {}) {
    this.maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxQueueSize = config.maxQueueSize ?? DEFAULT_MAX_QUEUE;
    this.persistPath = config.persistPath;
    if (this.persistPath) this.loadFromDisk(this.persistPath);
  }

  private loadFromDisk(persistPath: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(persistPath, 'utf-8');
    } catch {
      return; // no file yet — start empty
    }
    let tasks: DreamTask[];
    try {
      const data = JSON.parse(raw) as { tasks?: unknown };
      if (!Array.isArray(data.tasks)) throw new Error('missing tasks array');
      tasks = (data.tasks as DreamTask[]).filter(
        t => t && typeof t.id === 'string' && Array.isArray(t.sources) && typeof t.priority === 'number',
      );
    } catch {
      // Never destroy an unreadable queue file by saving over it — quarantine
      // it (same recovery contract as QualityArchive) and start empty.
      try {
        fs.renameSync(persistPath, `${persistPath}.corrupt-${Date.now()}`);
      } catch (renameErr) {
        // ENOENT: already gone. Anything else leaves the unreadable queue to be overwritten.
        if (!isEnoent(renameErr)) Logger.warn('DreamQueue', `could not quarantine corrupt queue ${persistPath}:`, renameErr);
      }
      return;
    }
    for (const task of tasks) {
      task.kind ??= 'artifact';
      // A persisted 'running' task means its consumer died mid-dream (single
      // consumer model: the self-improve cycle). Reclaim it so it can run again.
      if (task.status === 'running') task.status = 'queued';
      this.queue.push(task);
      const idNum = Number(/^dream-(\d+)-/.exec(task.id)?.[1] ?? 0);
      if (idNum > this.taskIdCounter) this.taskIdCounter = idNum;
    }
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({ version: 1, tasks: this.queue }, null, 2), 'utf-8');
    } catch (err) {
      // The in-memory queue stays authoritative, but the on-disk copy is now stale.
      Logger.warn('DreamQueue', `queue persistence failed: ${this.persistPath}:`, err);
    }
  }

  /**
   * Enqueue a dream task. A full queue may evict its lowest-priority stale
   * queued task; running and recently queued work is never displaced.
   */
  enqueue(
    strategy: DreamStrategy,
    sources: DreamTask['sources'],
    priority: number,
  ): string | undefined {
    this.prune();
    if (this.queue.length >= this.maxQueueSize && !this.evictStaleQueuedTask()) {
      return undefined;
    }

    const id = `dream-${++this.taskIdCounter}-${Date.now()}`;
    const task: DreamTask = {
      id,
      kind: 'artifact',
      strategy,
      sources,
      priority,
      status: 'queued',
      enqueuedAt: new Date().toISOString(),
    };

    this.queue.push(task);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.persist();
    return id;
  }

  enqueueComposition(
    plan: CompositionDreamPlan,
    sources: DreamTask['sources'],
    priority: number,
  ): string | undefined {
    this.prune();
    if (this.queue.length >= this.maxQueueSize && !this.evictStaleQueuedTask()) {
      return undefined;
    }
    const id = `dream-${++this.taskIdCounter}-${Date.now()}`;
    this.queue.push({
      id,
      kind: 'composition',
      strategy: 'cross-modal',
      sources,
      priority,
      status: 'queued',
      compositionPlan: plan,
      enqueuedAt: new Date().toISOString(),
    });
    this.queue.sort((a, b) => b.priority - a.priority);
    this.persist();
    return id;
  }

  private evictStaleQueuedTask(): boolean {
    const cutoff = Date.now() - STALE_QUEUED_TASK_MS;
    const stale = this.queue
      .filter(task => task.status === 'queued' && Date.parse(task.enqueuedAt) < cutoff)
      .sort((a, b) =>
        a.priority - b.priority
        || Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt)
      )[0];
    if (!stale) return false;
    this.queue.splice(this.queue.indexOf(stale), 1);
    return true;
  }

  /**
   * Dequeue the next runnable task (highest priority that fits concurrency).
   */
  dequeue(kind: DreamTaskKind = 'artifact'): DreamTask | undefined {
    if (this.runningCount >= this.maxConcurrent) return undefined;

    const task = this.queue.find(t => t.status === 'queued' && t.kind === kind);
    if (!task) return undefined;

    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.runningCount++;
    this.persist();
    return task;
  }

  /** Resume one previously claimed task without selecting newer generic work. */
  dequeueExact(taskId: string): DreamTask | undefined {
    if (this.runningCount >= this.maxConcurrent) return undefined;
    const task = this.queue.find(candidate =>
      candidate.id === taskId && candidate.status === 'queued');
    if (!task) return undefined;
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    this.runningCount++;
    this.persist();
    return task;
  }

  /**
   * Mark a task as completed with its result.
   */
  complete(taskId: string, result: DreamTask['result']): void {
    const task = this.queue.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return;

    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.result = result;
    this.runningCount--;
    this.persist();
  }

  /**
   * Mark a task as failed.
   */
  fail(taskId: string, result?: DreamTask['result']): void {
    const task = this.queue.find(t => t.id === taskId);
    if (!task || task.status !== 'running') return;

    task.status = 'failed';
    task.completedAt = new Date().toISOString();
    task.result = result;
    this.runningCount--;
    this.persist();
  }

  /**
   * Get current queue status.
   */
  getStatus(): {
    queued: number;
    running: number;
    completed: number;
    failed: number;
  } {
    const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
    for (const task of this.queue) counts[task.status]++;
    return counts;
  }

  /**
   * Get all tasks, optionally filtered by status.
   */
  getTasks(status?: DreamTask['status']): DreamTask[] {
    if (status) return this.queue.filter(t => t.status === status);
    return [...this.queue];
  }

  /**
   * Remove completed/failed tasks from the queue.
   */
  prune(): number {
    const before = this.queue.length;
    const prunable = this.queue.filter(t => t.status === 'completed' || t.status === 'failed');
    for (const t of prunable) {
      const idx = this.queue.indexOf(t);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    this.persist();
    return before - this.queue.length;
  }
}
