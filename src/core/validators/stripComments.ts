/**
 * Blank comments (block, line, HTML) so prose that merely mentions an API
 * cannot trip the rules. STRING-AWARE: string literals are kept intact AND
 * a `//` inside a string (https:// URLs) no longer blanks the rest of the
 * line — the v1 regex stripper ate real code after URLs (GLM #1068 note).
 * Walks the source once tracking string state; comments outside strings
 * are blanked in place.
 */
export function stripComments(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out.push(ch);
      i++;
      while (i < n) {
        if (code[i] === '\\' && i + 1 < n) { out.push(code[i], code[i + 1]); i += 2; continue; }
        out.push(code[i]);
        if (code[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out.push(code[i] === '\n' ? '\n' : ' '); i++; }
      if (i < n) { out.push(' ', ' '); i += 2; }
      continue;
    }
    if (ch === '<' && code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      while (i < stop) { out.push(code[i] === '\n' ? '\n' : ' '); i++; }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}
