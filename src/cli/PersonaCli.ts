/* eslint-disable no-console -- CLI command output: console output is intentional */
import { getMachinePersona, listPersonas } from '../atelier/PersonaFleet.js';

export function runPersonaCommand(cmdArgs: string[]): void {
  const cwd = process.cwd();
  if (cmdArgs[0] === 'list' || cmdArgs.length === 0) {
    const personas = listPersonas(cwd);
    console.log(`[persona] ${personas.length} cognitive-style personas registered:`);
    for (const p of personas) {
      console.log(`  ${p.name.padEnd(16)} exploration=${p.styleVector.exploration} connective=${p.styleVector.connectiveBias} machine=${p.machineHint}`);
    }
    const active = getMachinePersona(cwd);
    if (active) {
      console.log(`[persona] this machine: ${active.name} (${active.cognitiveStyle.slice(0, 60)}...)`);
    }
    return;
  }
  console.error('usage: sinter persona [list]');
}
