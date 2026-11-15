import { defmulti } from "@thi.ng/defmulti/defmulti";
import { AABB } from "./api/aabb.js";
import { Rect } from "./api/rect.js";
import { __unionBounds } from "./internal/bounds.js";
import { __dispatch } from "./internal/dispatch.js";
const union = defmulti(
  __dispatch,
  {
    rect: "aabb"
  },
  {
    aabb: (a, b) => new a.constructor(
      ...__unionBounds(a.pos, a.size, b.pos, b.size)
    )
  }
);
export {
  union
};
