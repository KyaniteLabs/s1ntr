import { setC, setC4 } from "@thi.ng/vectors/setc";
import { vop } from "@thi.ng/vectors/vop";
const outerProduct = vop(1);
const outerProduct2 = outerProduct.add(
  2,
  (out, [ux, uy], [vx, vy]) => setC4(out || [], ux * vx, uy * vx, ux * vy, uy * vy)
);
const outerProduct3 = outerProduct.add(
  3,
  (out, [ux, uy, uz], [vx, vy, vz]) => setC(
    out || [],
    ux * vx,
    uy * vx,
    uz * vx,
    ux * vy,
    uy * vy,
    uz * vy,
    ux * vz,
    uy * vz,
    uz * vz
  )
);
const outerProduct4 = outerProduct.add(
  4,
  (out, [ux, uy, uz, uw], [vx, vy, vz, vw]) => setC(
    out || [],
    ux * vx,
    uy * vx,
    uz * vx,
    uw * vx,
    ux * vy,
    uy * vy,
    uz * vy,
    uw * vy,
    ux * vz,
    uy * vz,
    uz * vz,
    uw * vz,
    ux * vw,
    uy * vw,
    uz * vw,
    uw * vw
  )
);
export {
  outerProduct,
  outerProduct2,
  outerProduct3,
  outerProduct4
};
