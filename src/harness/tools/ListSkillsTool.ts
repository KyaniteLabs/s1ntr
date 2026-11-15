import { Tool, type ToolResult } from './types.js';
import { SkillLoader } from '../skills/SkillLoader.js';

export class ListSkillsTool extends Tool {
  readonly name = 'listSkills';
  readonly description =
    'List discoverable harness skills (name + description) from repo .skills/ and agent skill roots. Params: {} optional {"query":"substr"}.';

  private readonly loader = new SkillLoader();

  async execute(params: unknown): Promise<ToolResult<{ skills: Array<{ name: string; description: string; source: string }> }>> {
    const query =
      params && typeof params === 'object' && typeof (params as { query?: unknown }).query === 'string'
        ? String((params as { query: string }).query).toLowerCase()
        : '';
    let skills = await this.discoverNames();
    if (query) {
      skills = skills.filter(
        (s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query),
      );
    }
    return { success: true, data: { skills } };
  }

  private async discoverNames(): Promise<Array<{ name: string; description: string; source: string }>> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out: Array<{ name: string; description: string; source: string }> = [];
    const candidates = [{ root: path.join(process.cwd(), '.skills'), source: 'repo' as const }];
    for (const c of candidates) {
      try {
        const entries = await fs.readdir(c.root, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          const skillMd = path.join(c.root, ent.name, 'SKILL.md');
          try {
            const raw = await fs.readFile(skillMd, 'utf8');
            const descLine = raw.split('\n').find((l) => l.startsWith('description:'));
            const nameLine = raw.split('\n').find((l) => l.startsWith('name:'));
            const strip = (line: string | undefined, key: string) =>
              (line ?? '')
                .slice(key.length)
                .trim()
                .replace(/^["']|["']$/g, '');
            out.push({
              name: strip(nameLine, 'name:') || ent.name,
              description: strip(descLine, 'description:'),
              source: c.source,
            });
          } catch {
            /* skip */
          }
        }
      } catch {
        /* root missing */
      }
    }
    if (!out.some((s) => s.name === 'comorbidity-check')) {
      const skill = await this.loader.loadSkill('comorbidity-check');
      if (skill) out.push({ name: skill.name, description: skill.description, source: skill.source });
    }
    return out;
  }
}

export const listSkillsTool = new ListSkillsTool();
