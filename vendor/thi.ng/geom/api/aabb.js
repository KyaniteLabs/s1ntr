import { add3 } from "@thi.ng/vectors/add";
import { addN3 } from "@thi.ng/vectors/addn";
import { ZERO3 } from "@thi.ng/vectors/api";
import { maddN3 } from "@thi.ng/vectors/maddn";
import { max3 } from "@thi.ng/vectors/max";
import { set3 } from "@thi.ng/vectors/set";
import { __asVec } from "../internal/args.js";
import { __copyAttribs } from "../internal/copy.js";
class AABB {
  constructor(pos = [0, 0, 0], size = 1, attribs) {
    this.pos = pos;
    this.attribs = attribs;
    this.size = max3(null, __asVec(size, 3), ZERO3);
  }
  pos;
  attribs;
  type = "aabb";
  dim = 3;
  size;
  copy() {
    return new AABB(
      set3([], this.pos),
      set3([], this.size),
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new AABB(this.pos, this.size, attribs);
  }
  min() {
    return set3([], this.pos);
  }
  max() {
    return add3([], this.pos, this.size);
  }
  offset(offset) {
    const c = maddN3([], this.size, 0.5, this.pos);
    max3(null, addN3(null, this.size, offset * 2), ZERO3);
    maddN3(this.pos, this.size, -0.5, c);
    return this;
  }
  toHiccup() {
    return ["aabb", this.attribs, this.pos, this.size];
  }
}
export {
  AABB
};
