import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { copy } from "@thi.ng/vectors/copy";
import { Line } from "./api/line.js";
import { Line3 } from "./api/line3.js";
import { Path } from "./api/path.js";
import { Path3 } from "./api/path3.js";
import { Polyline } from "./api/polyline.js";
import { asCubic } from "./as-cubic.js";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { pathFromCubics } from "./path-from-cubics.js";
const asPath = defmulti(
  __dispatch,
  {
    line: "polyline",
    quad: "poly",
    tri: "poly"
  },
  {
    [DEFAULT]: (src, opts) => opts?.linear ? asPath(asPolygon(src)[0], opts) : __defaultImpl(src, opts),
    arc: ($, opts) => opts?.linear ? asPath(asPolyline($)[0], opts) : __defaultImpl($, opts),
    complexpoly: ({ boundary, children, attribs }, opts) => {
      attribs = __copyAttribs(attribs);
      if (opts?.linear) {
        return __linearPath(
          boundary,
          children.map(
            (c) => __lineSegments(Line, c.points, true)
          ),
          true
        );
      }
      const res = pathFromCubics(asCubic(boundary, opts), attribs);
      for (const child of children) {
        res.addSubPaths(
          pathFromCubics(asCubic(child, opts)).segments
        );
      }
      return res;
    },
    poly: ($, opts) => opts?.linear ? __linearPath($, [], true) : __defaultImpl($, opts),
    polyline: ($, opts) => opts?.linear ? __linearPath($, [], false) : __defaultImpl($, opts)
  }
);
const __defaultImpl = (src, opts) => pathFromCubics(
  asCubic(src, { attribs: false, ...opts }),
  __copyAttribs(src.attribs)
);
function __lineSegments(ctor, points, closed) {
  const n = points.length;
  if (!n) return [];
  const segments = [{ type: "m", point: copy(points[0]) }];
  for (let i = 1; i < n; i++)
    segments.push({
      type: "l",
      geo: new ctor([copy(points[i - 1]), copy(points[i])])
    });
  if (closed) {
    segments.push(
      {
        type: "l",
        geo: new ctor([copy(points[n - 1]), copy(points[0])])
      },
      { type: "z" }
    );
  }
  return segments;
}
const __linearPath = (shape, subPaths, closed = false) => {
  const attribs = __copyAttribs(shape.attribs);
  return shape.dim === 2 ? new Path(
    __lineSegments(Line, shape.points, closed),
    subPaths,
    attribs
  ) : new Path3(
    __lineSegments(Line3, shape.points, closed),
    subPaths,
    attribs
  );
};
export {
  asPath
};
