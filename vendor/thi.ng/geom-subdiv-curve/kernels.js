import { wrapSides } from "@thi.ng/transducers/wrap-sides";
import { addmN } from "@thi.ng/vectors/addmn";
import { addW2, addW3, addW5 } from "@thi.ng/vectors/addw";
import { mag2 } from "@thi.ng/vectors/mag";
import { mixN } from "@thi.ng/vectors/mixn";
import { normalize2 } from "@thi.ng/vectors/normalize";
import { perpendicularCW } from "@thi.ng/vectors/perpendicular";
import { sub2 } from "@thi.ng/vectors/sub";
const kernel2 = ([ua, ub], [va, vb]) => ([a, b]) => [
  addW2([], a, b, ua, ub),
  addW2([], a, b, va, vb)
];
const kernel3 = ([ua, ub, uc], [va, vb, vc]) => ([a, b, c]) => [
  addW3([], a, b, c, ua, ub, uc),
  addW3([], a, b, c, va, vb, vc)
];
const kernel5 = ([ua, ub, uc, ud, ue], [va, vb, vc, vd, ve]) => ([a, b, c, d, e]) => [
  addW5([], a, b, c, d, e, ua, ub, uc, ud, ue),
  addW5([], a, b, c, d, e, va, vb, vc, vd, ve)
];
const __wrap2 = (pts, closed) => closed ? wrapSides(pts, 0, 1) : pts;
const __wrap3 = (pts, closed) => closed ? wrapSides(pts, 1, 1) : pts;
const SUBDIV_MID = {
  fn: ([a, b], i, nump, closed) => {
    const res = [a, addmN([], a, b, 0.5)];
    if (!closed && i === nump - 2) res.push(b);
    return res;
  },
  pre: __wrap2,
  size: 2
};
const SUBDIV_THIRDS = {
  fn: ([a, b], i, nump, closed) => {
    const res = [a, mixN([], a, b, 1 / 3), mixN([], a, b, 2 / 3)];
    if (!closed && i === nump - 2) res.push(b);
    return res;
  },
  pre: __wrap2,
  size: 2
};
const CHAIKIN_FIRST = kernel3([1 / 2, 1 / 2, 0], [0, 3 / 4, 1 / 4]);
const CHAIKIN_MAIN = kernel3([1 / 4, 3 / 4, 0], [0, 3 / 4, 1 / 4]);
const CHAIKIN_LAST = kernel3([1 / 4, 3 / 4, 0], [0, 1 / 2, 1 / 2]);
const SUBDIV_CHAIKIN = {
  fn: (pts, i, n, closed) => closed ? CHAIKIN_MAIN(pts) : i == 0 ? [pts[0], ...CHAIKIN_FIRST(pts)] : i === n - 3 ? [...CHAIKIN_LAST(pts), pts[2]] : CHAIKIN_MAIN(pts),
  pre: __wrap3,
  size: 3
};
const CUBIC_MAIN = kernel3([1 / 8, 3 / 4, 1 / 8], [0, 1 / 2, 1 / 2]);
const SUBDIV_CUBIC = {
  fn: (pts) => CUBIC_MAIN(pts),
  pre: (pts) => wrapSides(pts, 1, 1),
  size: 3
};
const DLG_MAIN = kernel5(
  [0, 0, 1, 0, 0],
  [0, -1 / 16, 9 / 16, 9 / 16, -1 / 16]
);
const SUBDIV_DLG = {
  fn: (pts) => DLG_MAIN(pts),
  pre: (pts) => wrapSides(pts, 2, 2),
  size: 5
};
const SUBDIV_DISPLACE = (displace) => ({
  fn: ([a, b], i, nump, closed) => {
    const delta = sub2([], b, a);
    const len = mag2(delta);
    const normal = perpendicularCW(null, normalize2([], delta));
    const res = [
      a,
      ...displace.map(
        ([t, x]) => addW3([], a, delta, normal, 1, t, x * len)
      )
    ];
    if (!closed && i === nump - 2) res.push(b);
    return res;
  },
  size: 2,
  pre: __wrap2
});
export {
  SUBDIV_CHAIKIN,
  SUBDIV_CUBIC,
  SUBDIV_DISPLACE,
  SUBDIV_DLG,
  SUBDIV_MID,
  SUBDIV_THIRDS,
  kernel2,
  kernel3,
  kernel5
};
