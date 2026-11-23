import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A host-installed scope that runs each evaluator-role provider call under its own
 * governed, receipted grant. Without a scope (the default) calls run unchanged, so
 * the existing generate/Create paths that already hold per-stage grants are untouched.
 * Long cycles that interleave generation and judging (the living-site daemon, ledger
 * runs) install one so judge calls get evaluator authority, not the outer generator grant.
 */
export type EvaluatorScope = <T>(call: () => Promise<T>) => Promise<T>;

const scopes = new AsyncLocalStorage<EvaluatorScope>();

export function withEvaluatorScope<T>(scope: EvaluatorScope, operation: () => Promise<T>): Promise<T> {
  return scopes.run(scope, operation);
}

/** Run one evaluator provider call under the installed scope, or directly when none is installed. */
export function evaluatorCall<T>(call: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  return scope ? scope(call) : call();
}
