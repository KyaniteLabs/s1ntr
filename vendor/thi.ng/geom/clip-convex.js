import { defmulti } from "@thi.ng/defmulti/defmulti";
import {
  clipLineSegmentPoly,
  clipPolylinePoly
} from "@thi.ng/geom-clip-line/clip-poly";
import { sutherlandHodgeman } from "@thi.ng/geom-clip-poly";
import { centroid } from "@thi.ng/geom-poly-utils/centroid";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { ComplexPolygon } from "./api/complex-polygon.js";
import { Group } from "./api/group.js";
import { Line } from "./api/line.js";
import { Path } from "./api/path.js";
import { Polygon } from "./api/polygon.js";
import { Polyline } from "./api/polyline.js";
import { asPolyline } from "./as-polyline.js";
import { __copyAttribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __pointArraysAsShapes } from "./internal/points-as-shape.js";
import { ensureVertices, vertices } from "./vertices.js";
const __clipVertices = ($, boundary) => {
  boundary = ensureVertices(boundary);
  const pts = sutherlandHodgeman(vertices($), boundary, centroid(boundary));
  return pts.length ? [new Polygon(pts, __copyAttribs($.attribs))] : void 0;
};
const clipConvex = defmulti(
  __dispatch,
  {
    circle: "$verts",
    ellipse: "$verts",
    quad: "poly",
    rect: "$verts",
    tri: "poly"
  },
  {
    $verts: __clipVertices,
    complexpoly: ($, boundary) => {
      boundary = ensureVertices(boundary);
      const c = centroid(boundary);
      let clipped = sutherlandHodgeman(
        $.boundary.points,
        boundary,
        c
      );
      if (!clipped.length) return void 0;
      const res = [new Polygon(clipped)];
      for (const child of $.children) {
        clipped = sutherlandHodgeman(child.points, boundary, c);
        if (clipped.length) res.push(new Polygon(clipped));
      }
      return [
        new ComplexPolygon(
          res[0],
          res.slice(1),
          __copyAttribs($.attribs)
        )
      ];
    },
    extra: ($) => [$],
    group: ({ children, attribs }, boundary) => {
      boundary = ensureVertices(boundary);
      const clipped = [];
      for (const c of children) {
        const res = clipConvex(c, boundary);
        if (res) clipped.push(...res);
      }
      return clipped.length ? [new Group({ ...attribs }, clipped)] : void 0;
    },
    line: ($, boundary) => {
      const segments = clipLineSegmentPoly(
        $.points[0],
        $.points[1],
        ensureVertices(boundary)
      );
      return segments?.length ? [new Line(segments[0], __copyAttribs($.attribs))] : void 0;
    },
    path: ($, boundary) => {
      boundary = ensureVertices(boundary);
      if (!$.closed) {
        return [
          ...mapcat(
            (poly) => clipConvex(poly, boundary),
            asPolyline($)
          )
        ];
      }
      let clipped = __clipVertices($, boundary);
      if (!clipped) return void 0;
      const res = new ComplexPolygon(
        clipped[0],
        [],
        __copyAttribs($.attribs)
      );
      for (const sub of $.subPaths) {
        clipped = __clipVertices(
          new Path(sub, [], __copyAttribs($.attribs)),
          boundary
        );
        if (clipped) {
          clipped[0].attribs = void 0;
          res.addChild(clipped[0]);
        }
      }
      return [res];
    },
    poly: ($, boundary) => {
      boundary = ensureVertices(boundary);
      const pts = sutherlandHodgeman(
        $.points,
        boundary,
        centroid(boundary)
      );
      return pts.length ? [new Polygon(pts, __copyAttribs($.attribs))] : void 0;
    },
    polyline: ({ points, attribs }, boundary) => __pointArraysAsShapes(
      Polyline,
      clipPolylinePoly(points, ensureVertices(boundary)),
      attribs
    )
  }
);
export {
  clipConvex
};
