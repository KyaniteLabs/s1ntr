import { __copyShape } from "../internal/copy.js";
import { __ensureNumVerts } from "../internal/pclike.js";
import { APC } from "./apc.js";
class Quadratic extends APC {
  type = "quadratic";
  dim = 2;
  constructor(points, attribs) {
    super(points, attribs);
    __ensureNumVerts(this.points.length, 3);
  }
  copy() {
    return __copyShape(Quadratic, this);
  }
  copyTransformed(fn) {
    return __copyShape(Quadratic, this, fn(this.points));
  }
  withAttribs(attribs) {
    return new Quadratic(this.points, attribs);
  }
  toHiccup() {
    const [a, b, c] = this.points;
    return [
      "path",
      this.attribs,
      [
        ["M", a],
        ["Q", b, c]
      ]
    ];
  }
  toHiccupPathSegments() {
    const [_, b, c] = this.points;
    return [["Q", b, c]];
  }
}
export {
  Quadratic
};
