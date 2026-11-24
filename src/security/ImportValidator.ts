import path from 'path';

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

/**
 * Validate that an import path is within the project root
 */
export function validateImportPath(importPath: string, projectRoot: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(resolvedRoot, importPath);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (
    relative === '..'
    || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative)
  ) {
    throw new ImportValidationError(
      `Import path ${importPath} escapes project root ${projectRoot}`
    );
  }

  return resolvedPath;
}
