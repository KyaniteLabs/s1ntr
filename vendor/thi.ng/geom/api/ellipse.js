import { set2 } from "@thi.ng/vectors/set";
import { __asVec } from "../internal/args.js";
import { __copyAttribs } from "../internal/copy.js";
class Ellipse {
  constructor(pos = [0, 0], r = [1, 1], attribs) {
    this.pos = pos;
    this.attribs = attribs;
    this.r = __asVec(r);
  }
  pos;
  attribs;
  type = "ellipse";
  dim = 2;
  r;
  copy() {
    return new Ellipse(
      set2([], this.pos),
      set2([], this.r),
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Ellipse(this.pos, this.r, attribs);
  }
  toHiccup() {
    return [this.type, this.attribs, this.pos, this.r];
  }
}
export {
  Ellipse
};
