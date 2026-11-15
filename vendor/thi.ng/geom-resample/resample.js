import { isNumber } from "@thi.ng/checks/is-number";
import { isPlainObject } from "@thi.ng/checks/is-plain-object";
import { copyVectors } from "@thi.ng/vectors/copy";
import { DEFAULT_SAMPLES } from "./api.js";
import { Sampler } from "./sampler.js";
const resample = (pts, opts, closed = false, copy = false) => {
  if (__validateOpts(opts)) {
    const sampler = new Sampler(pts, closed);
    return isPlainObject(opts) ? closed ? opts.dist ? sampler.sampleUniform(opts.dist, opts.last) : sampler.sampleFixedNum(
      opts.num || DEFAULT_SAMPLES,
      opts.last
    ) : opts.dist ? sampler.sampleUniform(opts.dist, opts.last !== false) : sampler.sampleFixedNum(
      opts.num || DEFAULT_SAMPLES,
      opts.last !== false
    ) : sampler.sampleFixedNum(opts || DEFAULT_SAMPLES, !closed);
  }
  return copy ? copyVectors(pts) : pts;
};
const __validateOpts = (opts) => opts !== void 0 && (isNumber(opts) || opts.dist != null || opts.last != null || opts.num != null);
export {
  resample
};
