import { cross2 } from "@thi.ng/vectors/cross";
import { signedArea2 } from "@thi.ng/vectors/signed-area";
const polyArea2 = (pts) => {
  const n = pts.length - 1;
  if (n < 2) return 0;
  let res = 0;
  let a = pts[n];
  let b = pts[0];
  for (let i = 0; i <= n; a = b, b = pts[++i]) {
    res += cross2(a, b);
  }
  return res / 2;
};
const triArea2 = signedArea2;
export {
  polyArea2,
  triArea2
};
