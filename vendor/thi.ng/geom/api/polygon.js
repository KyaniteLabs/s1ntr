import { __copyShape } from "../internal/copy.js";
import { APC } from "./apc.js";
class Polygon extends APC {
  type = "poly";
  dim = 2;
  add(...points) {
    this.points.push(...points);
  }
  copy() {
    return __copyShape(Polygon, this);
  }
  copyTransformed(fn) {
    return __copyShape(Polygon, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Polygon(this.points, attribs);
  }
  toHiccup() {
    return ["polygon", this.attribs, this.points];
  }
}
export {
  Polygon
};
