const stringify = (all = false, indent) => (x) => all || typeof x !== "string" && typeof x !== "number" ? JSON.stringify(
  x instanceof Error ? x.stack ?? x.message : x instanceof RegExp ? x.source : x,
  null,
  indent
) : String(x);
export {
  stringify
};
