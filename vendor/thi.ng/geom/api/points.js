import { __copyShape } from "../internal/copy.js";
import { APC } from "./apc.js";
class Points extends APC {
  type = "points";
  dim = 2;
  copy() {
    return __copyShape(Points, this);
  }
  copyTransformed(fn) {
    return __copyShape(Points, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Points(this.points, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.points];
  }
}
export {
  Points
};
