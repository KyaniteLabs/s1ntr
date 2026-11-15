import { ensureArray } from "@thi.ng/arrays/ensure-array";
import { __copyAttribs } from "../internal/copy.js";
import { Polygon } from "./polygon.js";
class ComplexPolygon {
  constructor(boundary = new Polygon(), children, attribs) {
    this.boundary = boundary;
    this.attribs = attribs;
    this.children = children ? ensureArray(children) : [];
  }
  boundary;
  attribs;
  type = "complexpoly";
  dim = 2;
  children;
  *[Symbol.iterator]() {
    yield this.boundary;
    yield* this.children;
  }
  addChild(poly) {
    this.children.push(poly);
  }
  copy() {
    return new ComplexPolygon(
      this.boundary.copy(),
      this.children.map((h) => h.copy()),
      __copyAttribs(this.attribs)
    );
  }
  copyTransformed(fn) {
    return new ComplexPolygon(
      fn(this.boundary),
      this.children.map((child) => fn(child)),
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new ComplexPolygon(this.boundary, this.children, attribs);
  }
  toHiccup() {
    const segments = [];
    const $hiccupSegments = ({ points }) => {
      if (!points.length) return;
      segments.push(["M", points[0]]);
      for (let i = 1, n = points.length; i < n; i++) {
        segments.push(["L", points[i]]);
      }
      segments.push(["z"]);
    };
    $hiccupSegments(this.boundary);
    for (const c of this.children) $hiccupSegments(c);
    return ["path", this.attribs, segments];
  }
}
export {
  ComplexPolygon
};
