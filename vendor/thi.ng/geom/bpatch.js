import { assert } from "@thi.ng/errors/assert";
import { mixBilinear } from "@thi.ng/vectors/mix-bilinear";
import { BPatch } from "./api/bpatch.js";
const bpatch = (pts, attribs) => new BPatch(pts, attribs);
const bpatchFromQuad = (pts, attribs) => {
  assert(pts.length === 4, "require 4 points");
  const [a, b, c, d] = pts;
  const cps = [];
  for (let u = 0; u < 4; u++) {
    for (let v = 0; v < 4; v++) {
      cps.push(mixBilinear([], a, b, d, c, u / 3, v / 3));
    }
  }
  return new BPatch(cps, attribs);
};
const bpatchFromHex = (pts, attribs) => {
  assert(pts.length === 6, "require 6 points");
  const [a, b, c, d, e, f] = pts;
  return new BPatch(
    [e, e, f, f, d, d, a, a, d, d, a, a, c, c, b, b],
    attribs
  );
};
export {
  bpatch,
  bpatchFromHex,
  bpatchFromQuad
};
