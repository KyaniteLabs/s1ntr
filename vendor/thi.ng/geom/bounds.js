import { defmulti } from "@thi.ng/defmulti/defmulti";
import { bounds as arcBounds } from "@thi.ng/geom-arc/bounds";
import { bounds2, bounds3 } from "@thi.ng/geom-poly-utils/bounds";
import { cubicBounds } from "@thi.ng/geom-splines/cubic-bounds";
import { quadraticBounds } from "@thi.ng/geom-splines/quadratic-bounds";
import { comp } from "@thi.ng/transducers/comp";
import { filter } from "@thi.ng/transducers/filter";
import { iterator1 } from "@thi.ng/transducers/iterator";
import { map } from "@thi.ng/transducers/map";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { addN2 } from "@thi.ng/vectors/addn";
import { max2 } from "@thi.ng/vectors/max";
import { min2 } from "@thi.ng/vectors/min";
import { mul2 } from "@thi.ng/vectors/mul";
import { mulN2 } from "@thi.ng/vectors/muln";
import { sub2 } from "@thi.ng/vectors/sub";
import { subN2 } from "@thi.ng/vectors/subn";
import { aabbFromMinMaxWithMargin } from "./aabb.js";
import { Rect } from "./api/rect.js";
import { __collBounds } from "./internal/bounds.js";
import { __dispatch } from "./internal/dispatch.js";
import { rectFromMinMaxWithMargin } from "./rect.js";
const bounds = defmulti(
  __dispatch,
  {
    aabb: "rect",
    bpatch: "points",
    poly: "points",
    polyline: "points",
    quad: "points",
    tri: "points"
  },
  {
    arc: ($, margin = 0) => rectFromMinMaxWithMargin(
      ...arcBounds($.pos, $.r, $.axis, $.start, $.end),
      margin
    ),
    bpatch: ({ points }, margin = 0) => rectFromMinMaxWithMargin(
      ...bounds2([
        ...mapcat(
          (pts) => cubicBounds(...pts),
          [
            [points[0], points[1], points[2], points[3]],
            [points[3], points[7], points[11], points[15]],
            [points[12], points[13], points[14], points[15]],
            [points[0], points[4], points[8], points[12]]
          ]
        )
      ]),
      margin
    ),
    circle: ($, margin = 0) => new Rect(
      subN2([], $.pos, $.r + margin),
      mulN2(null, [2, 2], $.r + margin)
    ),
    complexpoly: ($, margin = 0) => {
      const res = __collBounds([$.boundary, ...$.children], bounds);
      return res ? new Rect(...res).offset(margin) : void 0;
    },
    cubic: ({ points }, margin = 0) => rectFromMinMaxWithMargin(
      ...cubicBounds(points[0], points[1], points[2], points[3]),
      margin
    ),
    ellipse: ($, margin = 0) => {
      const r = addN2([], $.r, margin);
      return new Rect(sub2([], $.pos, r), mul2(null, [2, 2], r));
    },
    extra: () => void 0,
    group: ($, margin = 0) => {
      const res = __collBounds($.children, bounds);
      return res ? new Rect(...res).offset(margin) : void 0;
    },
    line: ({ points: [a, b] }, margin = 0) => rectFromMinMaxWithMargin(min2([], a, b), max2([], a, b), margin),
    path: (path, margin = 0) => {
      const $segmentGeo = (segments) => iterator1(
        comp(
          map((s) => s.geo),
          filter((s) => !!s)
        ),
        segments
      );
      const b = __collBounds(
        [
          ...$segmentGeo(path.segments),
          ...mapcat($segmentGeo, path.subPaths)
        ],
        bounds
      );
      return b ? new Rect(...b).offset(margin) : void 0;
    },
    points: ($, margin = 0) => rectFromMinMaxWithMargin(...bounds2($.points), margin),
    points3: ($, margin = 0) => aabbFromMinMaxWithMargin(...bounds3($.points), margin),
    quadratic: ({ points }, margin = 0) => rectFromMinMaxWithMargin(
      ...quadraticBounds(points[0], points[1], points[2]),
      margin
    ),
    rect: ($, margin = 0) => margin === 0 ? $.copy() : $.copy().offset(margin),
    text: ($, margin = 0) => new Rect(subN2([], $.pos, margin), margin * 2)
  }
);
export {
  bounds
};
