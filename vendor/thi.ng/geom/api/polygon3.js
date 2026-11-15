import { __copyShape } from "../internal/copy.js";
import { APC } from "./apc.js";
class Polygon3 extends APC {
  type = "poly3";
  dim = 3;
  add(...points) {
    this.points.push(...points);
  }
  copy() {
    return __copyShape(Polygon3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Polygon3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Polygon3(this.points, attribs);
  }
  toHiccup() {
    return ["polygon3", this.attribs, this.points];
  }
}
export {
  Polygon3
};
