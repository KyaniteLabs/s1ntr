import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Cubic3 extends APC {
  type = "cubic3";
  dim = 3;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 4);
  }
  copy() {
    return __copyShape(Cubic3, this);
  }
  copyTransformed(fn) {
    return __copyShape(Cubic3, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Cubic3(this.points, attribs);
  }
  toHiccup() {
    const [a, b, c, d] = this.points;
    return [
      "path3",
      this.attribs,
      [
        ["M", a],
        ["C", b, c, d]
      ]
    ];
  }
  toHiccupPathSegments() {
    const [_, b, c, d] = this.points;
    return [["C", b, c, d]];
  }
}
export {
  Cubic3
};
