/**
 * Load `./.env` without letting it steer endpoints, binaries or safety switches.
 *
 * A `.env` in whatever folder the user runs `sinter` from (a cloned repo, a
 * download) used to be loaded whole. One planted line could send the user's
 * shell API key to another server (`SINTER_LLM_BASE_URL`), pick the browser
 * binary, inject `NODE_OPTIONS`, or turn off the sandbox and SSRF guard.
 *
 * Now only API keys, model names and the log level are taken from the file,
 * and never over a value the shell already set. The rest is ignored with one
 * stderr line. `SINTER_TRUST_DOTENV=1`, read from the shell only, restores the
 * old load-everything behaviour.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ALLOWED: RegExp[] = [
  /^(SINTER_|LIMINAL_)?[A-Z0-9_]*_API_KEY$/,
  /^(SINTER_|LIMINAL_)?[A-Z0-9_]*_MODEL$/,
  /^SINTER_LOG_LEVEL$/,
];

export interface ProjectDotenvResult {
  applied: string[];
  ignored: string[];
}

export function isAllowedDotenvName(name: string): boolean {
  return ALLOWED.some((re) => re.test(name));
}

/** SINTER_X <-> LIMINAL_X: the other spelling of the same setting (src/utils/env.ts prefers SINTER_). */
function brandAlias(name: string): string {
  if (name.startsWith("SINTER_")) return `LIMINAL_${name.slice("SINTER_".length)}`;
  if (name.startsWith("LIMINAL_")) return `SINTER_${name.slice("LIMINAL_".length)}`;
  return name;
}

export function loadProjectDotenv(
  options: { cwd?: string; env?: NodeJS.ProcessEnv; warn?: (line: string) => void } = {},
): ProjectDotenvResult {
  const env = options.env ?? process.env;
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const file = path.join(options.cwd ?? process.cwd(), ".env");
  const result: ProjectDotenvResult = { applied: [], ignored: [] };

  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(fs.readFileSync(file));
  } catch {
    return result; // missing or unreadable: nothing to load
  }

  const trustAll = env.SINTER_TRUST_DOTENV === "1";
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] !== undefined || env[brandAlias(name)] !== undefined) continue; // the shell always wins, under either brand spelling
    if (trustAll || isAllowedDotenvName(name)) {
      env[name] = value;
      result.applied.push(name);
    } else {
      result.ignored.push(name);
    }
  }

  if (result.ignored.length > 0) {
    warn(
      `Ignored from ./.env: ${result.ignored.join(", ")} (export them in your shell, or set SINTER_TRUST_DOTENV=1 to load the whole file).`,
    );
  }
  return result;
}
