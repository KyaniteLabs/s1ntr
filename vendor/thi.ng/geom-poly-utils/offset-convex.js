import { add2 } from "@thi.ng/vectors/add";
import { cornerBisector } from "@thi.ng/vectors/bisect";
const offsetConvex = (points, dist) => {
  const res = [];
  for (let n = points.length, i = n - 1, j = 0; j < n; i = j, j++) {
    res.push(
      add2(
        null,
        points[j],
        cornerBisector(
          [],
          points[i],
          points[j],
          points[(j + 1) % n],
          -dist
        )
      )
    );
  }
  return res;
};
export {
  offsetConvex
};
