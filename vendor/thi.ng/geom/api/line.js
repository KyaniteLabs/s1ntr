import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { __hiccupLineSegment } from "../internal/vertices.js";
import { APC } from "./apc.js";
class Line extends APC {
  type = "line";
  dim = 2;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 2);
  }
  copy() {
    return __copyShape(Line, this);
  }
  copyTransformed(fn) {
    return __copyShape(Line, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Line(this.points, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.points[0], this.points[1]];
  }
  toHiccupPathSegments() {
    return [__hiccupLineSegment(this.points[0], this.points[1])];
  }
}
export {
  Line
};
