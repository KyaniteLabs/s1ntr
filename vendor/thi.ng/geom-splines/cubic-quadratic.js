import { mixN } from "@thi.ng/vectors/mixn";
import { set } from "@thi.ng/vectors/set";
const cubicFromQuadratic = (a, b, c) => [
  set([], a),
  mixN([], a, b, 2 / 3),
  mixN([], c, b, 2 / 3),
  set([], c)
];
const quadraticFromCubic = (a, b, c, d, gamma = 0.5) => {
  const qb = mixN([], a, b, 1.5 * gamma);
  const qd = mixN([], d, c, 1.5 * (1 - gamma));
  const qc = mixN([], qb, qd, gamma);
  return [
    [set([], a), qb, qc],
    [set([], qc), qd, set([], d)]
  ];
};
export {
  cubicFromQuadratic,
  quadraticFromCubic
};
