import { set3 } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Plane {
  constructor(normal = [0, 1, 0], w = 0, attribs) {
    this.normal = normal;
    this.w = w;
    this.attribs = attribs;
  }
  normal;
  w;
  attribs;
  type = "plane";
  dim = 3;
  copy() {
    return new Plane(
      set3([], this.normal),
      this.w,
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Plane(this.normal, this.w, attribs);
  }
  toHiccup() {
    return ["plane", this.attribs, this.normal, this.w];
  }
}
export {
  Plane
};
