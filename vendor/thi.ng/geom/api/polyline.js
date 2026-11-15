import { __copyShape } from "../internal/copy.js";
import { __hiccupLineSegment } from "../internal/vertices.js";
import { APC } from "./apc.js";
class Polyline extends APC {
  type = "polyline";
  dim = 2;
  add(...points) {
    this.points.push(...points);
  }
  copy() {
    return __copyShape(Polyline, this);
  }
  copyTransformed(fn) {
    return __copyShape(Polyline, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Polyline(this.points, attribs);
  }
  toHiccup() {
    return [this.type, { ...this.attribs, fill: "none" }, this.points];
  }
  toHiccupPathSegments() {
    const res = [];
    for (let pts = this.points, n = pts.length, i = 1; i < n; i++) {
      res.push(__hiccupLineSegment(pts[i - 1], pts[i]));
    }
    return res;
  }
}
export {
  Polyline
};
