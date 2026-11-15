import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Quad3 extends APC {
  type = "quad3";
  dim = 3;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 4);
  }
  copy() {
    return __copyShape(Quad3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Quad3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Quad3(this.points, attribs);
  }
  toHiccup() {
    return ["polygon3", this.attribs, this.points];
  }
}
export {
  Quad3
};
