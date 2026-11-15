import { set2 } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Circle {
  constructor(pos = [0, 0], r = 1, attribs) {
    this.pos = pos;
    this.r = r;
    this.attribs = attribs;
  }
  pos;
  r;
  attribs;
  type = "circle";
  dim = 2;
  copy() {
    return new Circle(
      set2([], this.pos),
      this.r,
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Circle(this.pos, this.r, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.pos, this.r];
  }
}
export {
  Circle
};
