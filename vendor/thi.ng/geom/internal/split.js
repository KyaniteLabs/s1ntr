import { mixN } from "@thi.ng/vectors/mixn";
import { __pointArraysAsShapes } from "./points-as-shape.js";
import { clamp01 } from "@thi.ng/math/interval";
const __splitLineAt = ({ points: [a, b], attribs, constructor: ctor }, t = 0) => {
  const p = mixN([], a, b, clamp01(t));
  return __pointArraysAsShapes(
    ctor,
    [
      [a, p],
      [p, b]
    ],
    attribs
  );
};
export {
  __splitLineAt
};
