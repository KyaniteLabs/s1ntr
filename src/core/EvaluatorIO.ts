/**
 * Evaluator-reply and evaluator-image helpers. Kept out of ScoringEngine so judge
 * modules reachable from the production entry import only scoreRenderedEvidence from it.
 */

export function firstJsonObject(input: string): string | undefined {
  const start = input.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return input.slice(start, index + 1);
  }
  return undefined;
}

export async function boundedEvaluatorImages(images: Array<{
  mimeType: string; dataBase64: string; width?: number; height?: number; label: string;
}>): Promise<typeof images> {
  if (images.reduce((sum, image) => sum + image.dataBase64.length, 0) < 500_000) return images;
  const { default: sharp } = await import('sharp');
  return Promise.all(images.map(async image => {
    const { data, info } = await sharp(Buffer.from(image.dataBase64, 'base64'))
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return {
      ...image,
      mimeType: 'image/jpeg',
      dataBase64: data.toString('base64'),
      width: info.width,
      height: info.height,
      label: `${image.label}-normalized`,
    };
  }));
}

/**
 * Judges reviewing ASCII/terminal art quote backslashes inside their notes, which is
 * invalid JSON ("Bad escaped character"). Parse strictly first; only on failure double
 * each backslash that does not start a valid JSON escape, then parse again.
 */
export function parseJudgeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch (strictError) {
    const repaired = text.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
    if (repaired === text) throw strictError;
    return JSON.parse(repaired);
  }
}
