import { SQRT3_2 } from "@thi.ng/math/api";
import { add2 } from "@thi.ng/vectors/add";
import { maddN2 } from "@thi.ng/vectors/maddn";
import { mag2 } from "@thi.ng/vectors/mag";
import { normalize2 } from "@thi.ng/vectors/normalize";
import { perpendicularCCW } from "@thi.ng/vectors/perpendicular";
import { sub2 } from "@thi.ng/vectors/sub";
const equilateralTriangle2 = (a, b) => {
  const dir = sub2([], b, a);
  return [
    a,
    b,
    add2(
      null,
      normalize2(null, perpendicularCCW([], dir), mag2(dir) * SQRT3_2),
      maddN2(dir, dir, 0.5, a)
    )
  ];
};
export {
  equilateralTriangle2
};
