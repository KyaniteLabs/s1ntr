import { maddN2 } from "@thi.ng/vectors/maddn";
import { set2 } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Ray {
  constructor(pos, dir, attribs) {
    this.pos = pos;
    this.dir = dir;
    this.attribs = attribs;
  }
  pos;
  dir;
  attribs;
  type = "ray";
  dim = 2;
  copy() {
    return new Ray(
      set2([], this.pos),
      set2([], this.dir),
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Ray(this.pos, this.dir, attribs);
  }
  toHiccup() {
    return [
      "line",
      this.attribs,
      this.pos,
      maddN2([], this.dir, 1e6, this.pos)
    ];
  }
}
export {
  Ray
};
