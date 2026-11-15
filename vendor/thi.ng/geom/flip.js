import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { neg } from "@thi.ng/vectors/neg";
import { __dispatch } from "./internal/dispatch.js";
const flip = defmulti(
  __dispatch,
  {
    cubic: "$pclike",
    cubic3: "$pclike",
    line: "$pclike",
    line3: "$pclike",
    points: "$pclike",
    points3: "$pclike",
    poly: "$pclike",
    polyline: "$pclike",
    quad: "$pclike",
    quad3: "$pclike",
    quadratic: "$pclike",
    quadratic3: "$pclike",
    ray3: "ray",
    tri: "$pclike",
    tri3: "$pclike"
  },
  {
    [DEFAULT]: (x) => x,
    $pclike: ($) => {
      $.points.reverse();
      return $;
    },
    arc: ($) => {
      const t = $.start;
      $.start = $.end;
      $.end = t;
      $.cw = !$.cw;
      return $;
    },
    complexpoly: ($) => {
      flip($.boundary);
      for (const c of $.children) flip(c);
      return $;
    },
    group: ($) => {
      $.children.forEach(flip);
      return $;
    },
    path: ($) => {
      return $;
    },
    ray: ($) => {
      $.dir = neg(null, $.dir);
      return $;
    }
  }
);
export {
  flip
};
