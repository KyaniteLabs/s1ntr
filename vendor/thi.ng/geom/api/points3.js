import { __copyShape } from "../internal/copy.js";
import { APC } from "./apc.js";
class Points3 extends APC {
  type = "points3";
  dim = 3;
  copy() {
    return __copyShape(Points3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Points3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Points3(this.points, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.points];
  }
}
export {
  Points3
};
