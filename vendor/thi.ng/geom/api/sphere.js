import { set3 } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Sphere {
  constructor(pos = [0, 0, 0], r = 1, attribs) {
    this.pos = pos;
    this.r = r;
    this.attribs = attribs;
  }
  pos;
  r;
  attribs;
  type = "sphere";
  dim = 3;
  copy() {
    return new Sphere(
      set3([], this.pos),
      this.r,
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Sphere(this.pos, this.r, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.pos, this.r];
  }
}
export {
  Sphere
};
