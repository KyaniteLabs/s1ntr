import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Line3 extends APC {
  type = "line3";
  dim = 3;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 2);
  }
  copy() {
    return __copyShape(Line3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Line3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Line3(this.points, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.points[0], this.points[1]];
  }
  toHiccupPathSegments() {
    return [["L", this.points[1]]];
  }
}
export {
  Line3
};
