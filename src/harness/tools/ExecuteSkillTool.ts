import { Tool, type ToolResult } from './types.js';
import { SkillLoader, type LoadedSkill } from '../skills/SkillLoader.js';

export interface ExecuteSkillParams {
  name: string;
}

export interface ExecuteSkillResult {
  skill: LoadedSkill;
}

/** Max nested executeSkill depth in one agent turn stack (GLM comorbidity: skill-chain budget). */
export const MAX_EXECUTE_SKILL_DEPTH = 5;

/** Test-only / process-local nest depth for sequential harness agent loops. */
let executeSkillNestDepth = 0;

export function getExecuteSkillNestDepth(): number {
  return executeSkillNestDepth;
}

/** Reset nest depth (tests). */
export function resetExecuteSkillNestDepth(): void {
  executeSkillNestDepth = 0;
}

export class ExecuteSkillTool extends Tool {
  readonly name = 'executeSkill';
  readonly description =
    'Load a local SKILL.md and return its instructions for harness planning. Core Sinter skills: comorbidity-check, systematic-debugging (repo .skills/). Also discovers ~/.agents/skills and ~/.codex/skills. Params: {"name":"comorbidity-check"}. Skills may instruct loading other skills via this tool (max chain depth 5); this tool does not run shell.';

  private readonly loader: SkillLoader;

  constructor(roots?: string[]) {
    super();
    this.loader = new SkillLoader(roots);
  }

  async execute(params: unknown): Promise<ToolResult<ExecuteSkillResult>> {
    const { name } = (params || {}) as ExecuteSkillParams;
    if (typeof name !== 'string' || name.trim() === '') {
      return {
        success: false,
        error: 'executeSkill requires params.name to be a non-empty skill name, for example {"name":"karpathy-guidelines"}. This tool loads SKILL.md instructions; it cannot run shell commands. Use gitStatus for repository state, readFile/listDir/search/searchCode for inspection, or typeCheck/runBuild/runTests for verification.',
      };
    }

    if (executeSkillNestDepth >= MAX_EXECUTE_SKILL_DEPTH) {
      return {
        success: false,
        error: `executeSkill depth limit (${MAX_EXECUTE_SKILL_DEPTH}) exceeded — stop chaining skills and act on loaded instructions. Use readFile/search/gitStatus for inspection.`,
      };
    }

    executeSkillNestDepth += 1;
    try {
      const skill = await this.loader.loadSkill(name.trim());
      if (!skill) {
        return { success: false, error: `Skill not found: ${name}` };
      }

      return {
        success: true,
        data: { skill },
      };
    } finally {
      executeSkillNestDepth -= 1;
    }
  }
}

export const executeSkillTool = new ExecuteSkillTool();
