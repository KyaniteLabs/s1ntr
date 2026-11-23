import fs from 'node:fs';

/** Read the user config a command cannot run without; a missing file gets an actionable message, not a raw ENOENT. */
export function readRequiredSinterConfig(configPath: string, command: string): any {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`${command} needs the judge seats from ${configPath}, which does not exist. Run "sinter provider help" to set up a provider, then retry.`);
    }
    throw err;
  }
  return JSON.parse(text);
}
