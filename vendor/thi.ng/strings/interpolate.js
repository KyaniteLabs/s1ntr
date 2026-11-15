import { illegalArgs } from "@thi.ng/errors/illegal-arguments";
const TPL = /\{(\d+)\}/g;
const TPL_K = /\{([a-z0-9_.-]+)\}/gi;
const interpolate = (src, ...args) => args.length > 0 ? src.replace(TPL, (_, id) => String(args[parseInt(id, 10)])) : src;
const interpolateKeys = (src, keys, ignoreMissing = false) => src.replace(
  TPL_K,
  (match, id) => keys[id] != void 0 ? String(keys[id]) : ignoreMissing ? match : illegalArgs(`missing key: ${id}`)
);
export {
  interpolate,
  interpolateKeys
};
