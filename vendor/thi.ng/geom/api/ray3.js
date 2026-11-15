import { maddN3 } from "@thi.ng/vectors/maddn";
import { set3 } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Ray3 {
  constructor(pos, dir, attribs) {
    this.pos = pos;
    this.dir = dir;
    this.attribs = attribs;
  }
  pos;
  dir;
  attribs;
  type = "ray3";
  dim = 3;
  copy() {
    return new Ray3(
      set3([], this.pos),
      set3([], this.dir),
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Ray3(this.pos, this.dir, attribs);
  }
  toHiccup() {
    return [
      "line3",
      this.attribs,
      this.pos,
      maddN3([], this.dir, 1e6, this.pos)
    ];
  }
}
export {
  Ray3
};
