import { defmulti } from "@thi.ng/defmulti/defmulti";
import {
  KERNEL_BOX as $BOX,
  KERNEL_GAUSSIAN as $GAUSSIAN,
  KERNEL_TRIANGLE as $TRIANGLE,
  convolveClosed,
  convolveOpen
} from "@thi.ng/geom-poly-utils/convolve";
import { __dispatch } from "./internal/dispatch.js";
const convolve = defmulti(
  __dispatch,
  {
    complexpoly: "group",
    group3: "group",
    poly3: "poly",
    polyline3: "polyline"
  },
  {
    group: ($, k, t, iter) => $.copyTransformed((x) => convolve(x, k, t, iter)),
    poly: ($, k, t, iter) => __convolve(convolveClosed, $, k, t, iter),
    polyline: ($, k, t, iter) => __convolve(convolveOpen, $, k, t, iter)
  }
);
const __convolve = (fn, $, kernel, t, iter) => $.copyTransformed((points) => fn(points, kernel, t, iter));
const KERNEL_BOX = $BOX;
const KERNEL_TRIANGLE = $TRIANGLE;
const KERNEL_GAUSSIAN = $GAUSSIAN;
export {
  KERNEL_BOX,
  KERNEL_GAUSSIAN,
  KERNEL_TRIANGLE,
  convolve
};
