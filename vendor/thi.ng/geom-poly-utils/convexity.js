import { EPS } from "@thi.ng/math/api";
import { corner2 } from "@thi.ng/vectors/clockwise";
var Convexity = /* @__PURE__ */ ((Convexity2) => {
  Convexity2[Convexity2["ILLEGAL"] = -1] = "ILLEGAL";
  Convexity2[Convexity2["COLINEAR"] = 0] = "COLINEAR";
  Convexity2[Convexity2["CONVEX"] = 1] = "CONVEX";
  Convexity2[Convexity2["CONCAVE"] = 2] = "CONCAVE";
  return Convexity2;
})(Convexity || {});
const convexity = (pts, eps = EPS) => {
  let n = pts.length;
  if (n < 3) {
    return n < 2 ? -1 /* ILLEGAL */ : 0 /* COLINEAR */;
  }
  let type = 0;
  let a = pts[n - 2];
  let b = pts[n - 1];
  let c = pts[0];
  for (let i = 0; i < n && type < 3; a = b, b = c, c = pts[++i]) {
    const t = corner2(a, b, c, eps);
    type |= t < 0 ? 1 : t > 0 ? 2 : 0;
  }
  return type === 3 ? 2 /* CONCAVE */ : type > 0 ? 1 /* CONVEX */ : 0 /* COLINEAR */;
};
export {
  Convexity,
  convexity
};
