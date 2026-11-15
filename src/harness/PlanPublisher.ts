/**
 * Single plan publisher (IW-S03).
 * Only this module may commit diagnose plan artifacts under receipts/.
 * Tool-call JSON repair stays elsewhere and must not publish plans.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeDiagnosePlanFile } from './SelfImproveCompoundLoop.js';

export interface PlanPublishInput {
  runDir: string;
  taskId: string;
  planText: string;
  attemptId?: string;
}

export interface PlanPublishResult {
  planPath: string;
  contentDigest: string;
  reused: boolean;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Idempotent normalize for plan markdown (repair-at-publish only). */
export function normalizePlanText(planText: string): string {
  let t = planText.replace(/\r\n/g, '\n').trim();
  if (!t.endsWith('\n')) t += '\n';
  return t;
}

/**
 * Publish one canonical plan. Same attempt+digest returns existing path (idempotent).
 * Conflicting content for same task without matching digest overwrites only when force=false
 * records prior digest in sidecar for gate visibility.
 */
export function publishDiagnosePlan(input: PlanPublishInput): PlanPublishResult {
  const normalized = normalizePlanText(input.planText);
  if (normalized.trim().length < 200) {
    throw new Error('plan_too_short: diagnose plan must be ≥200 chars after normalize');
  }
  const contentDigest = digest(normalized);
  const receiptsDir = join(input.runDir, 'receipts');
  mkdirSync(receiptsDir, { recursive: true });
  const metaPath = join(receiptsDir, `${input.taskId}-plan.meta.json`);
  const planPath = join(receiptsDir, `${input.taskId}-plan.md`);

  if (existsSync(metaPath) && existsSync(planPath)) {
    try {
      const prev = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        contentDigest?: string;
        attemptId?: string;
        attemptIds?: string[];
      };
      if (prev.contentDigest === contentDigest) {
        // L2: reused path still records attempt linkage (Wave8 Kimi residual)
        const attemptIds = Array.isArray(prev.attemptIds) ? [...prev.attemptIds] : [];
        if (input.attemptId && !attemptIds.includes(input.attemptId)) {
          attemptIds.push(input.attemptId);
        }
        writeFileSync(
          metaPath,
          JSON.stringify(
            {
              ...prev,
              attemptId: input.attemptId ?? prev.attemptId ?? null,
              attemptIds,
              lastReusedAt: new Date().toISOString(),
              publisher: 'PlanPublisher.publishDiagnosePlan',
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
        return { planPath, contentDigest, reused: true };
      }
    } catch {
      /* fall through to write */
    }
  }

  const written = writeDiagnosePlanFile(input.runDir, input.taskId, normalized);
  const attemptIds = input.attemptId ? [input.attemptId] : [];
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        taskId: input.taskId,
        attemptId: input.attemptId ?? null,
        attemptIds,
        contentDigest,
        publishedAt: new Date().toISOString(),
        publisher: 'PlanPublisher.publishDiagnosePlan',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return { planPath: written, contentDigest, reused: false };
}
