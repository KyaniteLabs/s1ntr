/**
 * Deterministic repair for near-JSON tool-call objects from harness models
 * (e.g. GLM omitting quotes on expectedResult). Prefer extracting tool+params
 * even when free-text fields are malformed.
 */

export type RepairedToolCall = {
  thought: string;
  tool: string;
  params: Record<string, unknown>;
  expectedResult: string;
};

/** Extract first balanced {...} substring, or null. */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Quote bare (unquoted) string values after known top-level keys.
 * Handles: "expectedResult":Loads SKILL...  →  "expectedResult":"Loads SKILL..."
 */
export function quoteBareStringFields(jsonish: string): string {
  // After "key": if next non-space is not " { [ digit t/f/n - then treat as bare string
  // until unescaped comma at depth 0 or closing brace at depth 0.
  const keys = 'thought|tool|expectedResult';
  const re = new RegExp(
    `"(${keys})"\\s*:\\s*(?!\\s*["{\\[\\d\\-tfn])([^\\n\\r]*)`,
    'gi',
  );
  return jsonish.replace(re, (_m, key: string, rest: string) => {
    // Trim trailing , or } that belong to the object structure
    let value = rest.trim();
    let trailing = '';
    if (value.endsWith(',')) {
      trailing = ',';
      value = value.slice(0, -1).trim();
    } else if (value.endsWith('}')) {
      // leave } to the outer parser — if value includes }, it's part of bare text
      // only strip a single trailing } if the whole object ends here
    }
    // If bare value still ends with }, separate it
    if (value.endsWith('}') && !value.includes('{')) {
      trailing = '}' + trailing;
      value = value.slice(0, -1).trim();
    }
    // Strip accidental surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return `"${key}":${JSON.stringify(value)}${trailing}`;
  });
}

/** Best-effort extract tool + params when full parse still fails. */
export function extractToolAndParams(text: string): { tool: string; params: Record<string, unknown> } | null {
  const toolMatch = text.match(/"tool"\s*:\s*"([A-Za-z][A-Za-z0-9_]*)"/);
  if (!toolMatch) return null;
  const tool = toolMatch[1];
  const paramsMatch = text.match(/"params"\s*:\s*(\{[\s\S]*?\})\s*(?:,|\n|"expectedResult"|"thought"|})/);
  let params: Record<string, unknown> = {};
  if (paramsMatch) {
    try {
      params = JSON.parse(paramsMatch[1]) as Record<string, unknown>;
    } catch {
      // try name-only skill pattern
      const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
      if (nameMatch) params = { name: nameMatch[1] };
    }
  } else {
    const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch) params = { name: nameMatch[1] };
  }
  return { tool, params };
}

/**
 * Repair GLM/near-JSON tool call text into a structured ToolCall-like object.
 * Returns null if tool cannot be recovered.
 */
export function repairToolCallFromText(text: string): RepairedToolCall | null {
  const stripped = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinkContent\b[^>]*>[\s\S]*?<\/thinkContent>/gi, '')
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, '')
    .trim();

  const candidates: string[] = [];
  const code = stripped.match(/```json\s*([\s\S]*?)```/) || stripped.match(/```\s*([\s\S]*?)```/);
  if (code?.[1]) candidates.push(code[1].trim());
  const obj = extractFirstJsonObject(stripped);
  if (obj) candidates.push(obj);
  candidates.push(stripped);

  for (const cand of candidates) {
    for (const variant of [cand, quoteBareStringFields(cand)]) {
      try {
        const parsed = JSON.parse(variant) as Record<string, unknown>;
        if (typeof parsed.tool === 'string' && parsed.tool.trim()) {
          return {
            thought: typeof parsed.thought === 'string' ? parsed.thought : 'Repaired tool plan',
            tool: parsed.tool.trim(),
            params:
              parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
                ? (parsed.params as Record<string, unknown>)
                : {},
            expectedResult:
              typeof parsed.expectedResult === 'string'
                ? parsed.expectedResult
                : 'Repaired next tool call',
          };
        }
      } catch {
        // continue
      }
    }
  }

  const extracted = extractToolAndParams(stripped);
  if (!extracted) return null;
  const thoughtMatch = stripped.match(/"thought"\s*:\s*"((?:\\.|[^"\\])*)"/);
  return {
    thought: thoughtMatch?.[1]?.replace(/\\"/g, '"') || 'Recovered tool from partial JSON',
    tool: extracted.tool,
    params: extracted.params,
    expectedResult: 'Recovered tool+params',
  };
}
