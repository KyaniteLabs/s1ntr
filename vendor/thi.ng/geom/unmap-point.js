import { defmulti } from "@thi.ng/defmulti/defmulti";
import { madd } from "@thi.ng/vectors/madd";
import { mixBilinear } from "@thi.ng/vectors/mix-bilinear";
import { __dispatch } from "./internal/dispatch.js";
const unmapPoint = defmulti(
  __dispatch,
  {
    aabb: "rect",
    quad3: "quad"
  },
  {
    quad: ({ points }, uv, out = []) => mixBilinear(
      out,
      points[0],
      points[1],
      points[3],
      points[2],
      uv[0],
      uv[1]
    ),
    rect: ($, uvw, out = []) => madd(out, $.size, uvw, $.pos)
  }
);
export {
  unmapPoint
};
