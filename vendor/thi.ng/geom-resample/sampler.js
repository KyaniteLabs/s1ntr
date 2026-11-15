import {
  closestPointPolyline,
  closestPointSegment,
  closestT
} from "@thi.ng/geom-closest-point/line";
import { fit01 } from "@thi.ng/math/fit";
import { dist } from "@thi.ng/vectors/dist";
import { distSq } from "@thi.ng/vectors/distsq";
import { eqDelta } from "@thi.ng/vectors/eqdelta";
import { mixN } from "@thi.ng/vectors/mixn";
import { normalize } from "@thi.ng/vectors/normalize";
import { set } from "@thi.ng/vectors/set";
import { sub } from "@thi.ng/vectors/sub";
class Sampler {
  points;
  index;
  constructor(points, closed = false) {
    if (closed) {
      this.points = points.slice();
      this.points.push(points[0]);
    } else {
      this.points = points;
    }
    this.buildIndex();
  }
  totalLength() {
    const idx = this.index;
    return idx ? idx[idx.length - 1] : 0;
  }
  pointAt(t) {
    const pts = this.points;
    const n = pts.length - 1;
    if (n < 0) {
      return;
    }
    if (n === 0 || t <= 0) {
      return pts[0];
    }
    if (t >= 1) {
      return pts[n];
    }
    const idx = this.index;
    const t0 = t * idx[n];
    for (let i = 1; i <= n; i++) {
      if (idx[i] >= t0) {
        return mixN(
          [],
          pts[i - 1],
          pts[i],
          (t0 - idx[i - 1]) / (idx[i] - idx[i - 1])
        );
      }
    }
  }
  closestPoint(p) {
    return closestPointPolyline(p, this.points);
  }
  closestT(p) {
    const { index, points } = this;
    const tmp = [];
    const closest = [];
    let minD = Infinity;
    let minI = -1;
    for (let i = 0, n = index.length - 1; i < n; i++) {
      if (closestPointSegment(p, points[i], points[i + 1], tmp)) {
        const d = distSq(p, tmp);
        if (d < minD) {
          minD = d;
          minI = i;
          set(closest, tmp);
        }
      }
    }
    return minI >= 0 ? fit01(
      closestT(p, points[minI], points[minI + 1]) || 0,
      index[minI],
      index[minI + 1]
    ) / this.totalLength() : void 0;
  }
  segmentAt(t) {
    let i = this.indexAt(t);
    if (i === void 0) {
      return;
    }
    i = Math.max(1, i);
    return [this.points[i - 1], this.points[i]];
  }
  tangentAt(t, n = 1) {
    const seg = this.segmentAt(t);
    return seg ? normalize(null, sub([], seg[1], seg[0]), n) : void 0;
  }
  splitAt(t) {
    if (t <= 0 || t >= 1) {
      return [this.points];
    }
    const p = this.pointAt(t);
    if (!p) return;
    const i = Math.max(1, this.indexAt(t));
    const head = this.points.slice(0, i);
    const tail = this.points.slice(i);
    if (!eqDelta(head[i - 1], p)) {
      head.push(p);
    }
    if (!eqDelta(tail[0], p)) {
      tail.unshift(p);
    }
    return [head, tail];
  }
  splitNear(p) {
    const t = this.closestT(p);
    return t !== void 0 ? this.splitAt(t) : void 0;
  }
  /**
   * Returns vertex array for given interval of parametric positions (both
   * MUST be in `[0,1]` range).
   *
   * @example
   * ```ts tangle:../export/extract-range.ts
   * import { Sampler } from "@thi.ng/geom-resample";
   *
   * // vertices of a square
   * const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
   *
   * console.log(
   *   new Sampler(square, true).extractRange(0.2, 0.7)
   * );
   * // [[80, 0], [100, 0], [100, 100], [20, 100]]
   * ```
   *
   * @param start
   * @param end
   */
  extractRange(start, end) {
    if (start > end) {
      const t = start;
      start = end;
      end = t;
    }
    const pa = this.pointAt(start);
    const pb = this.pointAt(end);
    if (!(pa && pb)) return;
    const ia = Math.max(1, this.indexAt(start));
    const ib = Math.max(1, this.indexAt(end));
    const verts = this.points.slice(ia, ib);
    if (!verts.length || !eqDelta(verts[0], pa)) {
      verts.unshift(pa);
    }
    if (!eqDelta(verts[verts.length - 1], pb)) {
      verts.push(pb);
    }
    return verts;
  }
  indexAt(t) {
    const pts = this.points;
    const n = pts.length - 1;
    if (n < 0) {
      return;
    }
    if (n === 0 || t <= 0) {
      return 0;
    }
    if (t >= 1) {
      return n;
    }
    const idx = this.index;
    const t0 = t * idx[n];
    for (let i = 1; i <= n; i++) {
      if (idx[i] >= t0) {
        return i;
      }
    }
  }
  sampleUniform(dist2, includeLast = false, result = []) {
    const { index, points } = this;
    const total = this.totalLength();
    const delta = dist2 / total;
    const n = index.length;
    for (let t = 0, i = 1; t < 1; t += delta) {
      const ct = t * total;
      while (ct >= index[i] && i < n) {
        i++;
      }
      if (i >= n) break;
      const p = index[i - 1];
      result.push(
        mixN([], points[i - 1], points[i], (ct - p) / (index[i] - p))
      );
    }
    if (includeLast) {
      result.push(set([], points[points.length - 1]));
    }
    return result;
  }
  sampleFixedNum(num, includeLast = false, result) {
    return this.sampleUniform(
      this.totalLength() / num,
      includeLast,
      result
    );
  }
  buildIndex() {
    const idx = [0];
    const pts = this.points;
    const n = pts.length;
    for (let i = 0, j = 1; j < n; i = j, j++) {
      idx[j] = idx[i] + dist(pts[i], pts[j]);
    }
    this.index = idx;
  }
}
export {
  Sampler
};
