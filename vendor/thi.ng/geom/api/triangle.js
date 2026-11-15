import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Triangle extends APC {
  type = "tri";
  dim = 2;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 3);
  }
  copy() {
    return __copyShape(Triangle, this);
  }
  copyTransformed(fn) {
    return __copyShape(Triangle, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Triangle(this.points, attribs);
  }
  toHiccup() {
    return ["polygon", this.attribs, this.points];
  }
}
export {
  Triangle
};
