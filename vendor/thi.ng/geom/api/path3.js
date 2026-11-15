import { ensureArray } from "@thi.ng/arrays/ensure-array";
import { peek } from "@thi.ng/arrays/peek";
import { equiv } from "@thi.ng/equiv";
import { illegalState } from "@thi.ng/errors/illegal-state";
import { flatten1 } from "@thi.ng/transducers/flatten1";
import { __copyAttribs, __copySegment } from "../internal/copy.js";
class Path3 {
  constructor(segments, subPaths, attribs) {
    this.attribs = attribs;
    this.segments = segments ? ensureArray(segments) : [];
    this.subPaths = subPaths ? ensureArray(subPaths) : [];
  }
  attribs;
  type = "path3";
  dim = 3;
  segments;
  subPaths;
  /**
   * Returns true, if the last main segment is a closing segment, e.g. if the
   * path represents a closed shape.
   */
  get closed() {
    return peek(this.segments)?.type === "z";
  }
  *[Symbol.iterator]() {
    yield* this.segments;
    yield* flatten1(this.subPaths);
  }
  clear() {
    this.segments.length = 0;
  }
  empty() {
    return new Path3();
  }
  close() {
    if (!this.closed) this.segments.push({ type: "z" });
    return this;
  }
  copy() {
    return this.copyTransformed((segments) => segments.map(__copySegment));
  }
  copyTransformed(fn) {
    return new Path3(
      fn(this.segments),
      this.subPaths.map(fn),
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Path3(this.segments, this.subPaths, attribs);
  }
  equiv(o) {
    return o instanceof Path3 && equiv(this.segments, o.segments) && equiv(this.subPaths, o.subPaths);
  }
  isComplex() {
    return !!this.subPaths.length;
  }
  addSegments(...segments) {
    for (const s of segments) {
      this.closed && illegalState("path already closed");
      this.segments.push(s);
    }
    return this;
  }
  addSubPaths(...paths) {
    this.subPaths.push(...paths);
    return this;
  }
  toHiccup() {
    const acc = [];
    const $hiccupSegments = (segments) => {
      for (let i = 0, n = segments.length; i < n; i++) {
        const s = segments[i];
        if (s.geo) {
          acc.push(...s.geo.toHiccupPathSegments());
        } else if (s.point) {
          acc.push(["M", s.point]);
        } else {
          acc.push([s.type]);
        }
      }
    };
    if (this.segments.length > 1) {
      $hiccupSegments(this.segments);
    }
    for (const p of this.subPaths) $hiccupSegments(p);
    return ["path3", this.attribs || {}, acc];
  }
}
export {
  Path3
};
