/**
 * Model-written code goes into generated HTML in one of two ways. Both must
 * reach the browser exactly as written.
 */

/**
 * Code that runs as the body of an inline script. The HTML parser ends the
 * tag at `</script`, so that always gets a backslash. `<!--` followed later
 * by `<script` makes the parser skip the wrapper's own `</script>`; only then
 * does `<!--` get one too. The test is on the whole script, so a caller that
 * joins several pieces into one script escapes the joined text. A lone `<!--` is legal JS (a classic-script comment,
 * or inside a `u` regex where `\!` is an error), so it is left alone.
 */
export function scriptSafe(js: string): string {
  const safe = js.replace(/<\/script/gi, '<\\/script');
  return /<!--[\s\S]*<script/i.test(safe) ? safe.replace(/<!--/g, '<\\!--') : safe;
}

/** A JS string literal holding `text` byte for byte, safe inside an inline script. */
export function scriptString(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
