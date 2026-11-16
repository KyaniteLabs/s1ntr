/**
 * Script text that runs `fn(arg)` in a browser page through page.evaluate.
 * Builds with esbuild keepNames (tsx included) wrap named inner functions in
 * __name(), which a page lacks; the shim supplies it. The block keeps the
 * shim out of the page's globals.
 */
export function pageScript<A>(fn: (arg: A) => void, arg: A): string {
  return `{const __name=(value)=>value;(${fn.toString()})(${JSON.stringify(arg)});}`;
}

