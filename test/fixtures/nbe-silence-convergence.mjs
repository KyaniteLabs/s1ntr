// Suppress the signal in the generated page while letting the engine finish and declare readiness.
import { NbeGenerator } from '../../dist/generators/nbe/NbeGenerator.js';

const generate = NbeGenerator.prototype.generate;
NbeGenerator.prototype.generate = function (...args) {
  const result = generate.apply(this, args);
  const code = result.code.replace('<head>', '<head><script>window.postMessage = () => {};</script>');
  if (code === result.code) throw new Error('Convergence fixture could not instrument the engine page');
  return { ...result, code };
};
