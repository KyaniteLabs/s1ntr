import { equiv } from "@thi.ng/equiv";
import {
  pointAt as arcPointAt,
  pointAtTheta as arcPointAtTheta
} from "@thi.ng/geom-arc/point-at";
import { set2 } from "@thi.ng/vectors/set";
import { __copyAttribs } from "../internal/copy.js";
class Arc {
  constructor(pos, r, axis, start, end, xl = false, cw = false, attribs) {
    this.pos = pos;
    this.r = r;
    this.axis = axis;
    this.start = start;
    this.end = end;
    this.xl = xl;
    this.cw = cw;
    this.attribs = attribs;
  }
  pos;
  r;
  axis;
  start;
  end;
  xl;
  cw;
  attribs;
  type = "arc";
  dim = 2;
  copy() {
    return new Arc(
      set2([], this.pos),
      set2([], this.r),
      this.axis,
      this.start,
      this.end,
      this.xl,
      this.cw,
      __copyAttribs(this.attribs)
    );
  }
  withAttribs(attribs) {
    return new Arc(
      this.pos,
      this.r,
      this.axis,
      this.start,
      this.end,
      this.xl,
      this.cw,
      attribs
    );
  }
  equiv(o) {
    return o instanceof Arc && equiv(this.pos, o.pos) && equiv(this.r, o.r) && this.start === o.start && this.end === o.end && this.axis === o.axis && this.xl === o.xl && this.cw && o.cw;
  }
  pointAt(t, out = []) {
    return arcPointAt(
      this.pos,
      this.r,
      this.axis,
      this.start,
      this.end,
      t,
      out
    );
  }
  pointAtTheta(theta, out = []) {
    return arcPointAtTheta(this.pos, this.r, this.axis, theta, out);
  }
  toHiccup() {
    return [
      "path",
      this.attribs,
      [["M", this.pointAt(0)], this.toHiccupPathSegments()[0]]
    ];
  }
  toHiccupPathSegments() {
    return [
      [
        "A",
        this.r[0],
        this.r[1],
        this.axis,
        this.xl,
        this.cw,
        this.pointAt(1)
      ]
    ];
  }
}
export {
  Arc
};
