import { isArray } from "@thi.ng/checks/is-array";
import { defmulti } from "@thi.ng/defmulti/defmulti";
import * as sdc from "@thi.ng/geom-subdiv-curve/kernels";
import { subdivide } from "@thi.ng/geom-subdiv-curve/subdivide";
import { repeat } from "@thi.ng/transducers/repeat";
import { ComplexPolygon } from "./api/complex-polygon.js";
import { Group } from "./api/group.js";
import { Group3 } from "./api/group3.js";
import { Polygon } from "./api/polygon.js";
import { Polygon3 } from "./api/polygon3.js";
import { Polyline } from "./api/polyline.js";
import { Polyline3 } from "./api/polyline3.js";
import { asPolygon } from "./as-polygon.js";
import { asPolyline } from "./as-polyline.js";
import { __dispatch } from "./internal/dispatch.js";
const subdivCurve = defmulti(
  __dispatch,
  {
    arc: "$aspolyline",
    circle: "$aspoly",
    complexpoly: "group",
    ellipse: "$aspoly",
    group3: "group",
    line: "polyline",
    line3: "polyline",
    poly3: "poly",
    polyline3: "polyline",
    quad: "poly",
    quad3: "poly3",
    rect: "$aspoly",
    tri: "poly",
    tri3: "poly3"
  },
  {
    $aspolyline: ($, kernel, iter = 1) => subdivCurve(asPolyline($)[0], kernel, iter),
    $aspoly: ($, kernel, iter = 1) => subdivCurve(asPolygon($)[0], kernel, iter),
    group: ($, kernel, iter) => {
      kernel = __kernelArray(kernel, iter);
      return $.copyTransformed(
        (child) => subdivCurve(child, kernel, iter)
      );
    },
    poly: ($, kernel, iter) => $.copyTransformed(
      (points) => subdivide(points, __kernelArray(kernel, iter), true)
    ),
    polyline: ($, kernel, iter) => $.copyTransformed(
      (points) => subdivide(points, __kernelArray(kernel, iter))
    )
  }
);
const __kernelArray = (kernel, iter = 1) => isArray(kernel) ? kernel : [...repeat(kernel, iter)];
const SUBDIV_MID = sdc.SUBDIV_MID;
const SUBDIV_THIRDS = sdc.SUBDIV_THIRDS;
const SUBDIV_CHAIKIN = sdc.SUBDIV_CHAIKIN;
const SUBDIV_CUBIC = sdc.SUBDIV_CUBIC;
const SUBDIV_DISPLACE = sdc.SUBDIV_DISPLACE;
const SUBDIV_DLG = sdc.SUBDIV_DLG;
export {
  SUBDIV_CHAIKIN,
  SUBDIV_CUBIC,
  SUBDIV_DISPLACE,
  SUBDIV_DLG,
  SUBDIV_MID,
  SUBDIV_THIRDS,
  subdivCurve
};
