import { bounds2 } from "@thi.ng/geom-poly-utils/bounds";
import { sign } from "@thi.ng/math/abs";
import { mux2 } from "@thi.ng/morton/mux";
const earCutComplex = (holeIDs = [], hashThreshold = 80) => (tess, faces, pids) => {
  let points = tess.pointsForIDs(pids);
  const hasHoles = !!holeIDs.length;
  const outerLen = hasHoles ? holeIDs[0] : points.length;
  let scale = 0;
  if (points.length >= hashThreshold) {
    const [[minX, minY], [maxX, maxY]] = bounds2(points, 0, outerLen);
    scale = Math.max(maxX - minX, maxY - minY);
    if (scale > 0) {
      scale = 65535 / scale;
      points = points.map((p) => [
        (p[0] - minX) * scale,
        (p[1] - minY) * scale
      ]);
    }
  }
  let outerNode = __buildVertexList(points, pids, 0, outerLen, true);
  if (!outerNode || outerNode.n === outerNode.p) return faces;
  if (hasHoles) {
    outerNode = __eliminateHoles(points, pids, holeIDs, outerNode);
  } else {
    outerNode = __removeColinear(outerNode);
  }
  __earcutLinked(outerNode, faces, scale > 0 ? __isEarHashed : __isEar);
  return faces;
};
const earCutComplexPrepare = (boundary, holes) => {
  let points = boundary;
  const holeIDs = [];
  for (const hole of holes) {
    holeIDs.push(points.length);
    points = points.concat(hole);
  }
  return [points, holeIDs];
};
class Vertex {
  i;
  x;
  y;
  p = null;
  n = null;
  pz = null;
  nz = null;
  z = -1;
  s = false;
  constructor(i, x, y) {
    this.i = i;
    this.x = x;
    this.y = y;
  }
}
const __buildVertexList = (points, pids, start, end, clockwise) => {
  let last;
  if (clockwise === __signedArea(points, start, end) > 0) {
    for (let i = start; i < end; i++)
      last = __insertVertex(pids[i], points[i], last);
  } else {
    for (let i = end - 1; i >= start; i--)
      last = __insertVertex(pids[i], points[i], last);
  }
  if (last && __equals(last, last.n)) {
    __removeVertex(last);
    last = last.n;
  }
  return last;
};
const __insertVertex = (i, [x, y], last) => {
  const v = new Vertex(i, x, y);
  if (!last) {
    v.p = v.n = v;
  } else {
    v.n = last.n;
    v.p = last;
    last.n = last.n.p = v;
  }
  return v;
};
const __removeVertex = (v) => {
  v.n.p = v.p;
  v.p.n = v.n;
  if (v.pz) v.pz.nz = v.nz;
  if (v.nz) v.nz.pz = v.pz;
};
const __earcutLinked = (ear, triangles, pred, pass = 0) => {
  if (!ear) return;
  if (!pass && pred === __isEarHashed) __indexZCurve(ear);
  let stop = ear;
  while (ear.p !== ear.n) {
    const { p: prev, n: next } = ear;
    if (pred(ear)) {
      triangles.push([prev.i, ear.i, next.i]);
      __removeVertex(ear);
      ear = stop = next.n;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (pass === 0) {
        __earcutLinked(__removeColinear(ear), triangles, pred, 1);
      } else if (pass === 1) {
        ear = __cureLocalIntersections(
          __removeColinear(ear),
          triangles
        );
        __earcutLinked(ear, triangles, pred, 2);
      } else if (pass === 2) {
        __splitEarcut(ear, triangles, pred);
      }
      break;
    }
  }
};
const __splitEarcut = (start, triangles, pred) => {
  let a = start;
  do {
    let b = a.n.n;
    while (b !== a.p) {
      if (a.i !== b.i && __isValidDiagonal(a, b)) {
        let c = __splitPolygon(a, b);
        a = __removeColinear(a, a.n);
        c = __removeColinear(c, c.n);
        __earcutLinked(a, triangles, pred, 0);
        __earcutLinked(c, triangles, pred, 0);
        return;
      }
      b = b.n;
    }
    a = a.n;
  } while (a !== start);
};
const __splitPolygon = (a, b) => {
  const a2 = new Vertex(a.i, a.x, a.y);
  const b2 = new Vertex(b.i, b.x, b.y);
  const an = a.n;
  const bp = b.p;
  a.n = b;
  b.p = a;
  a2.n = an;
  an.p = a2;
  b2.n = a2;
  a2.p = b2;
  bp.n = b2;
  b2.p = bp;
  return b2;
};
const __isEdgeCentroidInside = (a, b) => {
  const mx = (a.x + b.x) * 0.5;
  const my = (a.y + b.y) * 0.5;
  let v = a;
  let inside = false;
  do {
    const { x: px, y: py, n: vn } = v;
    if (vn.y !== py && py > my !== vn.y > my && mx < (vn.x - px) * (my - py) / (vn.y - py) + px)
      inside = !inside;
    v = vn;
  } while (v !== a);
  return inside;
};
const __isLocallyInside = (a, b) => __area(a.p, a, a.n) < 0 ? __area(a, b, a.n) >= 0 && __area(a, a.p, b) >= 0 : __area(a, b, a.p) < 0 || __area(a, a.n, b) < 0;
const __intersectsPolygon = (a, b) => {
  let v = a;
  const ai = a.i;
  const bi = b.i;
  do {
    if (v.i !== ai && v.i !== bi && v.n.i !== ai && v.n.i !== bi && __intersects(v, v.n, a, b))
      return true;
    v = v.n;
  } while (v !== a);
  return false;
};
const __intersects = (p1, q1, p2, q2) => {
  const o1 = sign(__area(p1, q1, p2));
  const o2 = sign(__area(p1, q1, q2));
  const o3 = sign(__area(p2, q2, p1));
  const o4 = sign(__area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && __onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && __onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && __onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && __onSegment(p2, q1, q2)) return true;
  return false;
};
const __onSegment = ({ x: px, y: py }, { x: qx, y: qy }, { x: rx, y: ry }) => qx <= Math.max(px, rx) && qx >= Math.min(px, rx) && qy <= Math.max(py, ry) && qy >= Math.min(py, ry);
const __isValidDiagonal = (a, b) => a.n.i !== b.i && a.p.i !== b.i && !__intersectsPolygon(a, b) && (__isLocallyInside(a, b) && __isLocallyInside(b, a) && // locally visible
__isEdgeCentroidInside(a, b) && // does not create opposite-facing sectors
(__area(a.p, a, b.p) || __area(a, b.p, b)) || // special zero-length case
__equals(a, b) && __area(a.p, a, a.n) > 0 && __area(b.p, b, b.n) > 0);
const __isPointInTriangle = ({ x, y }, ax, ay, bx, by, cx, cy) => (cx - x) * (ay - y) >= (ax - x) * (cy - y) && (ax - x) * (by - y) >= (bx - x) * (ay - y) && (bx - x) * (cy - y) >= (cx - x) * (by - y);
const __isPointInRect = ({ x, y }, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const __findLeftmost = (start) => {
  let left = start;
  let v = start;
  do {
    if (v.x < left.x || v.x === left.x && v.y < left.y) left = v;
    v = v.n;
  } while (v !== start);
  return left;
};
const __sortLinked = (list) => {
  let numMerges;
  let inSize = 1;
  do {
    let p = list;
    let tail = list = null;
    let q, e;
    numMerges = 0;
    while (p) {
      numMerges++;
      q = p;
      let pSize = 0;
      for (let i = 0; i < inSize; i++) {
        pSize++;
        q = q.nz;
        if (!q) break;
      }
      let qSize = inSize;
      while (pSize > 0 || qSize > 0 && q) {
        if (pSize !== 0 && (qSize === 0 || !q || p.z <= q.z)) {
          e = p;
          p = p.nz;
          pSize--;
        } else {
          e = q;
          q = q.nz;
          qSize--;
        }
        if (tail) tail.nz = e;
        else list = e;
        e.pz = tail;
        tail = e;
      }
      p = q;
    }
    tail.nz = null;
    inSize *= 2;
  } while (numMerges > 1);
  return list;
};
const __indexZCurve = (start) => {
  let v = start;
  do {
    if (v.z < 0) v.z = mux2(v.x, v.y);
    v.pz = v.p;
    v = v.nz = v.n;
  } while (v !== start);
  v.pz.nz = v.pz = null;
  __sortLinked(v);
};
const __sectorContainsSector = (m, p) => __area(m.p, m, p.p) < 0 && __area(p.n, m, m.n) < 0;
const __findHoleBridge = (hole, outer) => {
  const { x: hx, y: hy } = hole;
  let v = outer;
  let qx = -Infinity;
  let px, py;
  let pnx, pny;
  let m;
  do {
    ({ x: px, y: py } = v);
    ({ x: pnx, y: pny } = v.n);
    if (hy <= py && hy >= pny && pny !== py) {
      const x = px + (hy - py) * (pnx - px) / (pny - py);
      if (x <= hx && x > qx) {
        qx = x;
        m = px < pnx ? v : v.n;
        if (x === hx) return m;
      }
    }
    v = v.n;
  } while (v !== outer);
  if (!m) return null;
  const stop = m;
  const { x: mx, y: my } = m;
  let tanMin = Infinity;
  let tan;
  v = m;
  do {
    ({ x: px, y: py } = v);
    if (hx >= px && px >= mx && hx !== px && __isPointInTriangle(
      v,
      hy < my ? hx : qx,
      hy,
      mx,
      my,
      hy < my ? qx : hx,
      hy
    )) {
      tan = Math.abs(hy - py) / (hx - px);
      if (__isLocallyInside(v, hole) && (tan < tanMin || tan === tanMin && (px > m.x || px === m.x && __sectorContainsSector(m, v)))) {
        m = v;
        tanMin = tan;
      }
    }
    v = v.n;
  } while (v !== stop);
  return m;
};
const __eliminateHole = (hole, outerNode) => {
  const bridge = __findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = __splitPolygon(bridge, hole);
  __removeColinear(bridgeReverse, bridgeReverse.n);
  return __removeColinear(bridge, bridge.n);
};
const __eliminateHoles = (points, pids, holeIndices, outerNode) => {
  const queue = [];
  for (let i = 0, num = holeIndices.length - 1; i <= num; i++) {
    const start = holeIndices[i];
    const end = i < num ? holeIndices[i + 1] : points.length;
    const list = __buildVertexList(points, pids, start, end, false);
    if (list === list.n) list.s = true;
    queue.push(__findLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  for (let i = 0, n = queue.length; i < n; i++) {
    outerNode = __eliminateHole(queue[i], outerNode);
  }
  return outerNode;
};
const __cureLocalIntersections = (start, triangles) => {
  let v = start;
  do {
    const a = v.p;
    const b = v.n.n;
    if (!__equals(a, b) && __isLocallyInside(a, b) && __isLocallyInside(b, a) && __intersects(a, v, v.n, b)) {
      triangles.push([a.i, v.i, b.i]);
      __removeVertex(v);
      __removeVertex(v.n);
      v = start = b;
    }
    v = v.n;
  } while (v !== start);
  return __removeColinear(v);
};
const __isEar = (ear) => {
  const { p: a, n: c } = ear;
  const b = ear;
  if (__area(a, b, c) >= 0) return false;
  const { x: ax, y: ay } = a, { x: bx, y: by } = b, { x: cx, y: cy } = c;
  const [x0, y0, x1, y1] = __triBounds(ax, ay, bx, by, cx, cy);
  let v = c.n;
  while (v !== a) {
    if (__isPointInRect(v, x0, y0, x1, y1) && __isPointInTriangle(v, ax, ay, bx, by, cx, cy) && __area(v.p, v, v.n) >= 0)
      return false;
    v = v.n;
  }
  return true;
};
const __isEarHashed = (ear) => {
  const { p: a, n: c } = ear;
  const b = ear;
  if (__area(a, b, c) >= 0) return false;
  const { x: ax, y: ay } = a;
  const { x: bx, y: by } = b;
  const { x: cx, y: cy } = c;
  const [x0, y0, x1, y1] = __triBounds(ax, ay, bx, by, cx, cy);
  const minZ = mux2(x0, y0);
  const maxZ = mux2(x1, y1);
  const check = (v) => v !== a && v !== c && __isPointInRect(v, x0, y0, x1, y1) && __isPointInTriangle(v, ax, ay, bx, by, cx, cy) && __area(v.p, v, v.n) >= 0;
  let { pz: p, nz: n } = ear;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (check(p) || check(n)) return false;
    p = p.pz;
    n = n.nz;
  }
  while (p && p.z >= minZ) {
    if (check(p)) return false;
    p = p.pz;
  }
  while (n && n.z <= maxZ) {
    if (check(n)) return false;
    n = n.nz;
  }
  return true;
};
const __removeColinear = (start, end = start) => {
  if (!start) return start;
  let v = start;
  let repeat;
  do {
    repeat = false;
    if (!v.s && (__equals(v, v.n) || sign(__area(v.p, v, v.n)) === 0)) {
      __removeVertex(v);
      v = end = v.p;
      if (v === v.n) break;
      repeat = true;
    } else {
      v = v.n;
    }
  } while (repeat || v !== end);
  return end;
};
const __area = (a, { x: bx, y: by }, c) => (by - a.y) * (c.x - bx) - (bx - a.x) * (c.y - by);
const __signedArea = (points, start, end) => {
  let sum = 0;
  for (let i = start, j = end - 1; i < end; j = i, i++) {
    const a = points[j];
    const b = points[i];
    sum += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return sum;
};
const __triBounds = (ax, ay, bx, by, cx, cy) => [
  ax < bx ? ax < cx ? ax : cx : bx < cx ? bx : cx,
  ay < by ? ay < cy ? ay : cy : by < cy ? by : cy,
  ax > bx ? ax > cx ? ax : cx : bx > cx ? bx : cx,
  ay > by ? ay > cy ? ay : cy : by > cy ? by : cy
];
const __equals = (pa, b) => pa.x === b.x && pa.y === b.y;
export {
  earCutComplex,
  earCutComplexPrepare
};
