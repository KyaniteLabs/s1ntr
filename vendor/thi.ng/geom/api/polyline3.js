import { __copyShape } from "../internal/copy.js";
import { APC } from "./apc.js";
class Polyline3 extends APC {
  type = "polyline3";
  dim = 3;
  add(...points) {
    this.points.push(...points);
  }
  copy() {
    return __copyShape(Polyline3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Polyline3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Polyline3(this.points, attribs);
  }
  toHiccup() {
    return [this.type, { ...this.attribs, fill: "none" }, this.points];
  }
  toHiccupPathSegments() {
    const res = [];
    for (let pts = this.points, n = pts.length, i = 1; i < n; i++) {
      res.push(["L", pts[i]]);
    }
    return res;
  }
}
export {
  Polyline3
};
