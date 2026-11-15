import { isNumber } from "@thi.ng/checks/is-number";
import { isPlainObject } from "@thi.ng/checks/is-plain-object";
import { DEFAULT_SAMPLES } from "@thi.ng/geom-resample/api";
import { Sampler } from "@thi.ng/geom-resample/sampler";
import { set } from "@thi.ng/vectors/set";
const __sample = (sample) => function $(pts, opts) {
  if (isPlainObject(opts) && opts.dist !== void 0) {
    return new Sampler(
      $(pts, opts.num || DEFAULT_SAMPLES)
    ).sampleUniform(
      opts.dist,
      opts.last !== false
    );
  }
  opts = isNumber(opts) ? {
    num: opts,
    last: true
  } : {
    num: DEFAULT_SAMPLES,
    ...opts
  };
  const res = [];
  sample(res, pts, opts.num);
  opts.last && res.push(set([], pts[pts.length - 1]));
  return res;
};
const __sampleArray = (fn) => (segments, closed = false, opts) => {
  const _opts = isNumber(opts) ? { num: opts } : opts;
  const n = segments.length - 1;
  return Array.prototype.concat.apply(
    [],
    segments.map(
      (seg, i) => fn(seg, { ..._opts, last: !closed && i === n })
    )
  );
};
export {
  __sample,
  __sampleArray
};
