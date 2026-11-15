import { ensureArray } from "@thi.ng/arrays/ensure-array";
class APC {
  constructor(points, attribs) {
    this.attribs = attribs;
    this.points = points ? ensureArray(points) : [];
  }
  attribs;
  points;
  *[Symbol.iterator]() {
    yield* this.points;
  }
  clear() {
    this.points.length = 0;
  }
}
export {
  APC
};
