import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Cubic extends APC {
  type = "cubic";
  dim = 2;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 4);
  }
  copy() {
    return __copyShape(Cubic, this);
  }
  copyTransformed(fn) {
    return __copyShape(Cubic, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Cubic(this.points, attribs);
  }
  toHiccup() {
    const [a, b, c, d] = this.points;
    return [
      "path",
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
  Cubic
};
