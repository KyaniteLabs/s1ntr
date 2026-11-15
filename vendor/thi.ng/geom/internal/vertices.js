import { isNumber } from "@thi.ng/checks/is-number";
import { DEFAULT_SAMPLES } from "@thi.ng/geom-resample/api";
import { TAU } from "@thi.ng/math/api";
const __circleOpts = (opts, r) => isNumber(opts) ? [opts, 0, false] : [
  opts.theta ? Math.floor(TAU / opts.theta) : opts.dist ? Math.floor(TAU / (opts.dist / r)) : opts.num || DEFAULT_SAMPLES,
  (opts.start || 0) * TAU,
  opts.last === true
];
const __sampleAttribs = (opts, attribs) => {
  if (attribs) {
    const val = attribs.__samples;
    return isNumber(opts) ? isNumber(val) ? val : { num: opts, ...val } : isNumber(val) ? { ...opts, num: val } : { ...opts, ...val };
  }
  return opts;
};
const __hiccupLineSegment = (a, b) => a[0] === b[0] ? ["V", b[1]] : a[1] === b[1] ? ["H", b[0]] : ["L", b];
export {
  __circleOpts,
  __hiccupLineSegment,
  __sampleAttribs
};
