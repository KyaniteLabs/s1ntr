import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { PI } from "@thi.ng/math/api";
import { __dispatch } from "./internal/dispatch.js";
const volume = defmulti(
  __dispatch,
  {},
  {
    [DEFAULT]: () => 0,
    aabb: ({ size }) => size[0] * size[1] * size[2],
    sphere: ($) => 4 / 3 * PI * $.r ** 3
  }
);
export {
  volume
};
