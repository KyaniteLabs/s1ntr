// Exercise the built CLI and file journal with an in-process compose delegate.
import { appendFileSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { CreativeRunCoordinator } from '../../dist/creative-run/CreativeRunCoordinator.js';
import { compileCreativeThesis } from '../../dist/creative-intelligence/CreativeIntelligence.js';
import { assertProviderAttemptAllowed } from '../../dist/llm/LLMClient.js';

Socket.prototype.connect = globalThis.fetch = () => { throw new Error('unexpected network call'); };
CreativeRunCoordinator.prototype.composeFromPrompt = async () => {
  assertProviderAttemptAllowed();
  appendFileSync('dispatches', 'x');
  const count = readFileSync('dispatches').length;
  if (count === 2) process.kill(process.pid, 'SIGKILL');
  const code = 'field ' + count;
  return { title: 'Field', html: '<html>field</html>', background: '#000', successCount: 1,
    creativeThesis: compileCreativeThesis('A field opens into light.'),
    layers: [{ domain: 'p5', prompt: 'a field', code, codeLength: code.length, generated: true,
      blendMode: 'normal', opacity: 1, artifactHtml: '<html>field</html>' }] };
};
