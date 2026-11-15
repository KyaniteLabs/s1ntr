import { peek } from "@thi.ng/arrays/peek";
import { defmulti } from "@thi.ng/defmulti/defmulti";
import { simplify as _simplify } from "@thi.ng/geom-resample/simplify";
import { ComplexPolygon } from "./api/complex-polygon.js";
import { Path } from "./api/path.js";
import { Polygon } from "./api/polygon.js";
import { Polyline } from "./api/polyline.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { vertices } from "./vertices.js";
const simplify = defmulti(
  __dispatch,
  {},
  {
    complexpoly: ($, eps) => new ComplexPolygon(
      simplify($.boundary, eps),
      $.children.map((child) => simplify(child, eps)),
      __copyAttribs($.attribs)
    ),
    path: ($, eps = 1e-6) => {
      const $simplifySegments = (segments) => {
        const res = [];
        const n = segments.length;
        let points;
        let lastP;
        for (let i = 0; i < n; i++) {
          const s = segments[i];
          if (s.type === "l" || s.type === "p") {
            points = points ? points.concat(vertices(s.geo)) : vertices(s.geo);
            lastP = peek(points);
          } else if (points) {
            points.push(lastP);
            res.push({
              geo: new Polyline(_simplify(points, eps)),
              type: "p"
            });
            points = null;
          } else {
            res.push({ ...s });
          }
        }
        if (points) {
          points.push(lastP);
          res.push({
            geo: new Polyline(points),
            type: "p"
          });
        }
        return res;
      };
      return new Path(
        $simplifySegments($.segments),
        $.subPaths.map($simplifySegments),
        __copyAttribs($.attribs)
      );
    },
    poly: ($, eps = 1e-6) => new Polygon(
      _simplify($.points, eps, true),
      __copyAttribs($.attribs)
    ),
    polyline: ($, eps = 1e-6) => new Polyline(_simplify($.points, eps), __copyAttribs($.attribs))
  }
);
export {
  simplify
};
