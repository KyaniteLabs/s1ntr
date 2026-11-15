import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Quad extends APC {
  type = "quad";
  dim = 2;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 4);
  }
  copy() {
    return __copyShape(Quad, this);
  }
  copyTransformed(fn) {
    return __copyShape(Quad, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Quad(this.points, attribs);
  }
  toHiccup() {
    return ["polygon", this.attribs, this.points];
  }
}
export {
  Quad
};
