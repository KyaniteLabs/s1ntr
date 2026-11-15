import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Triangle3 extends APC {
  type = "tri3";
  dim = 3;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 3);
  }
  copy() {
    return __copyShape(Triangle3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Triangle3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Triangle3(this.points, attribs);
  }
  toHiccup() {
    return ["polygon3", this.attribs, this.points];
  }
}
export {
  Triangle3
};
