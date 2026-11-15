import { peek } from "@thi.ng/arrays/peek";
import { unsupportedOp } from "@thi.ng/errors/unsupported";
import { eqDelta } from "@thi.ng/math/eqdelta";
import { add } from "@thi.ng/vectors/add";
import { copy } from "@thi.ng/vectors/copy";
import { eqDelta as eqDeltaV } from "@thi.ng/vectors/eqdelta";
import { mulN } from "@thi.ng/vectors/muln";
import { set } from "@thi.ng/vectors/set";
import { zeroes } from "@thi.ng/vectors/setn";
import { sub } from "@thi.ng/vectors/sub";
import { Cubic } from "./api/cubic.js";
import { Cubic3 } from "./api/cubic3.js";
import { Line } from "./api/line.js";
import { Line3 } from "./api/line3.js";
import { Path } from "./api/path.js";
import { Path3 } from "./api/path3.js";
import { Quadratic } from "./api/quadratic.js";
import { Quadratic3 } from "./api/quadratic3.js";
import { arcFrom2Points } from "./arc.js";
const P2D = {
  path: Path,
  a: arcFrom2Points,
  c: Cubic,
  l: Line,
  q: Quadratic
};
const P3D = {
  path: Path3,
  c: Cubic3,
  l: Line3,
  q: Quadratic3
};
class PathBuilder {
  constructor(ctors, attribs, opts = {}) {
    this.ctors = ctors;
    this.attribs = attribs;
    this.opts = opts;
    this.paths = [];
    this.attribs = attribs;
    this.newPath();
  }
  ctors;
  attribs;
  opts;
  /**
   * Array of all paths which have been built already (incl. the current)
   */
  paths;
  curr;
  currP;
  bezierP;
  startP;
  *[Symbol.iterator]() {
    yield* this.paths;
  }
  /**
   * Returns the current path being constructed.
   */
  current() {
    return this.curr;
  }
  /**
   * Starts a new path and makes it the current one. Any future build commands
   * will only act on this new path.
   */
  newPath() {
    this.curr = new this.ctors.path(
      [],
      [],
      this.attribs ? { ...this.attribs } : void 0
    );
    this.paths.push(this.curr);
    const dim = this.curr.dim;
    this.currP = zeroes(dim);
    this.bezierP = zeroes(dim);
    this.startP = zeroes(dim);
  }
  moveTo(p, relative = false) {
    if (this.opts.autoSplit !== false && this.curr.segments.length > 0) {
      this.curr = new this.ctors.path([], [], this.attribs);
      this.paths.push(this.curr);
    }
    p = this.updateCurrent(p, relative);
    set(this.startP, p);
    set(this.bezierP, p);
    this.curr.addSegments({
      type: "m",
      point: p
    });
    return this;
  }
  lineTo(p, relative = false) {
    this.curr.addSegments({
      type: "l",
      geo: new this.ctors.l([
        copy(this.currP),
        this.updateCurrent(p, relative)
      ])
    });
    set(this.bezierP, this.currP);
    return this;
  }
  hlineTo(x, relative = false) {
    this.addHVLine(x, 0, relative);
    return this;
  }
  vlineTo(y, relative = false) {
    this.addHVLine(y, 1, relative);
    return this;
  }
  // https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/d#Cubic_B%C3%A9zier_Curve
  cubicTo(cp1, cp2, p, relative = false) {
    this.addCubic(this.absPoint(cp1, relative), cp2, p, relative);
    return this;
  }
  // https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/d#Quadratic_B%C3%A9zier_Curve
  quadraticTo(cp, p, relative = false) {
    this.addQuadratic(this.absPoint(cp, relative), p, relative);
    return this;
  }
  cubicChainTo(cp2, p, relative = false) {
    const prevMode = peek(this.curr.segments).type;
    const c1 = copy(this.currP);
    prevMode === "c" && add(null, sub([], c1, this.bezierP), c1);
    this.addCubic(c1, cp2, p, relative);
    return this;
  }
  quadraticChainTo(p, relative = false) {
    const prevMode = peek(this.curr.segments).type;
    const c1 = copy(this.currP);
    prevMode === "q" && sub(null, mulN(null, c1, 2), this.bezierP);
    this.addQuadratic(c1, p, relative);
    return this;
  }
  arcTo(p, r, xaxis, xl, clockwise, relative = false) {
    if (!this.ctors.a) unsupportedOp("arcs");
    if (eqDelta(r[0], 0) || eqDelta(r[1], 0)) {
      return this.lineTo(p, relative);
    }
    const prev = copy(this.currP);
    this.curr.addSegments({
      type: "a",
      geo: this.ctors.a(
        prev,
        this.updateCurrent(p, relative),
        r,
        xaxis,
        xl,
        clockwise
      )
    });
    set(this.bezierP, this.currP);
    return this;
  }
  close() {
    if (!eqDeltaV(this.startP, this.currP)) {
      this.curr.addSegments({
        type: "l",
        geo: new this.ctors.l([copy(this.currP), copy(this.startP)])
      });
    }
    this.curr.close();
    return this;
  }
  updateCurrent(p, relative) {
    p = copy(relative ? add(null, this.currP, p) : set(this.currP, p));
    return p;
  }
  absPoint(p, relative) {
    return relative ? add(null, p, this.currP) : p;
  }
  addHVLine(p, i, relative) {
    const prev = copy(this.currP);
    this.currP[i] = relative ? this.currP[i] + p : p;
    set(this.bezierP, this.currP);
    this.curr.addSegments({
      type: "l",
      geo: new this.ctors.l([prev, copy(this.currP)])
    });
  }
  addCubic(cp1, cp2, p, relative) {
    cp2 = this.absPoint(cp2, relative);
    set(this.bezierP, cp2);
    this.curr.addSegments({
      type: "c",
      geo: new this.ctors.c([
        copy(this.currP),
        cp1,
        cp2,
        this.updateCurrent(p, relative)
      ])
    });
  }
  addQuadratic(cp, p, relative) {
    set(this.bezierP, cp);
    this.curr.addSegments({
      type: "q",
      geo: new this.ctors.q([
        copy(this.currP),
        cp,
        this.updateCurrent(p, relative)
      ])
    });
  }
}
const pathBuilder = (attribs, opts) => new PathBuilder(P2D, attribs, opts);
const pathBuilder3 = (attribs, opts) => new PathBuilder(P3D, attribs, opts);
export {
  PathBuilder,
  pathBuilder,
  pathBuilder3
};
