/**
 * Operator-owned state files (knowledge store, operation journal, product
 * projections) are parsed on the generate path. A truncated or hand-edited
 * file used to surface as a bare `SyntaxError: Expected property name...`
 * with no file name. This names the file and what to do about it.
 */
export class OperatorStateFileCorruptError extends Error {
  readonly code = 'OPERATOR_STATE_FILE_CORRUPT';
  constructor(readonly file: string, cause: unknown) {
    super(`OPERATOR_STATE_FILE_CORRUPT: ${file} is not valid JSON. Restore it from a backup before retrying.`, { cause });
    this.name = 'OperatorStateFileCorruptError';
  }
}

/** JSON.parse that names the file on failure. */
export function parseOperatorStateFile<T = unknown>(file: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new OperatorStateFileCorruptError(file, error);
  }
}
