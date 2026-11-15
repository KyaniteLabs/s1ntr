import { peek } from "@thi.ng/arrays/peek";
import { isArray } from "@thi.ng/checks/is-array";
import { isNumber } from "@thi.ng/checks/is-number";
import { defmulti } from "@thi.ng/defmulti/defmulti";
import { sample as _arcVertices } from "@thi.ng/geom-arc/sample";
import { DEFAULT_SAMPLES } from "@thi.ng/geom-resample/api";
import { resample } from "@thi.ng/geom-resample/resample";
import { sampleCubic } from "@thi.ng/geom-splines/cubic-sample";
import { sampleQuadratic } from "@thi.ng/geom-splines/quadratic-sample";
import { cossin } from "@thi.ng/math/angle";
import { TAU } from "@thi.ng/math/api";
import { add2, add3 } from "@thi.ng/vectors/add";
import { cartesian2 } from "@thi.ng/vectors/cartesian";
import { madd2 } from "@thi.ng/vectors/madd";
import { set2 } from "@thi.ng/vectors/set";
import { ComplexPolygon } from "./api/complex-polygon.js";
import { Polygon } from "./api/polygon.js";
import { __dispatch } from "./internal/dispatch.js";
import { __circleOpts, __sampleAttribs } from "./internal/vertices.js";
const vertices = defmulti(
  __dispatch,
  {
    bpatch: "points",
    cubic3: "cubic",
    group3: "group",
    line: "polyline",
    line3: "polyline",
    path3: "path",
    points3: "points",
    poly3: "poly",
    polyline3: "polyline",
    quad: "poly",
    quad3: "poly",
    quadratic3: "quadratic",
    tri: "poly",
    tri3: "poly"
  },
  {
    // e +----+ h
    //   |\   :\
    //   |f+----+ g
    //   | |  : |
    // a +-|--+d|
    //    \|   \|
    //   b +----+ c
    //
    aabb: ({ pos, size }) => {
      const [px, py, pz] = pos;
      const [qx, qy, qz] = add3([], pos, size);
      return [
        [px, py, pz],
        // a
        [px, py, qz],
        // b
        [qx, py, qz],
        // c
        [qx, py, pz],
        // d
        [px, qy, pz],
        // e
        [px, qy, qz],
        // f
        [qx, qy, qz],
        // g
        [qx, qy, pz]
        // h
      ];
    },
    arc: ($, opts) => _arcVertices(
      $.pos,
      $.r,
      $.axis,
      $.start,
      $.end,
      __sampleAttribs(opts, $.attribs)
    ),
    circle: ($, opts = DEFAULT_SAMPLES) => {
      opts = __sampleAttribs(opts, $.attribs);
      const pos = $.pos;
      const r = $.r;
      let [num, start, last] = __circleOpts(opts, r);
      const delta = TAU / num;
      last && num++;
      const buf = new Array(num);
      for (let i = 0; i < num; i++) {
        buf[i] = cartesian2(null, [r, start + i * delta], pos);
      }
      return buf;
    },
    complexpoly: ($, opts) => {
      const pts = vertices($.boundary, opts);
      for (const child of $.children) pts.push(...vertices(child, opts));
      return pts;
    },
    cubic: ($, opts) => sampleCubic($.points, __sampleAttribs(opts, $.attribs)),
    ellipse: ($, opts = DEFAULT_SAMPLES) => {
      opts = __sampleAttribs(opts, $.attribs);
      const buf = [];
      const pos = $.pos;
      const r = $.r;
      let [num, start, last] = __circleOpts(
        opts,
        Math.max($.r[0], $.r[1])
      );
      const delta = TAU / num;
      last && num++;
      for (let i = 0; i < num; i++) {
        buf[i] = madd2([], cossin(start + i * delta), r, pos);
      }
      return buf;
    },
    extra: () => [],
    group: ($, opts) => {
      opts = __sampleAttribs(opts, $.attribs);
      return $.children.reduce(
        (acc, $2) => acc.concat(vertices($2, opts)),
        []
      );
    },
    path: ($, opts) => {
      opts = __sampleAttribs(opts, $.attribs);
      const _opts = isNumber(opts) ? { num: opts } : opts;
      const verts = [];
      const $segmentVerts = (segments) => {
        const closed = peek(segments)?.type === "z";
        for (let n = segments.length - 1, i = 0; i <= n; i++) {
          const s = segments[i];
          if (!s.geo) continue;
          verts.push(
            ...vertices(s.geo, {
              ..._opts,
              last: !closed && i === n
            })
          );
        }
      };
      $segmentVerts($.segments);
      for (const sub of $.subPaths) $segmentVerts(sub);
      return verts;
    },
    points: ($) => $.points.slice(),
    poly: ($, opts) => resample($.points, __sampleAttribs(opts, $.attribs), true, true),
    polyline: ($, opts) => resample($.points, __sampleAttribs(opts, $.attribs), false, true),
    quadratic: ($, opts) => sampleQuadratic($.points, __sampleAttribs(opts, $.attribs)),
    rect: ($, opts) => {
      opts = __sampleAttribs(opts, $.attribs);
      const p = $.pos;
      const q = add2([], p, $.size);
      const verts = [set2([], p), [q[0], p[1]], q, [p[0], q[1]]];
      return opts != null ? vertices(new Polygon(verts), opts) : verts;
    }
  }
);
const ensureVertices = (shape) => isArray(shape) ? shape : vertices(shape);
export {
  ensureVertices,
  vertices
};
