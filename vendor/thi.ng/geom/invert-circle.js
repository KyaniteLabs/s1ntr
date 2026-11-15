import { maddN2 } from "@thi.ng/vectors/maddn";
import { magSq2 } from "@thi.ng/vectors/magsq";
import { sub2 } from "@thi.ng/vectors/sub";
const invertCircle = (c, ref) => {
  const delta = sub2([], c.pos, ref.pos);
  const len2 = magSq2(delta);
  const l = Math.sqrt(len2) + 1e-6;
  const ra2 = c.r * c.r;
  const rb2 = ref.r * ref.r;
  const s = l * rb2 / (len2 - ra2);
  c.pos = maddN2(null, delta, s / l, ref.pos);
  c.r = Math.abs(rb2 * c.r / (len2 - ra2));
  return c;
};
const invertCirclePoint = (p, ref) => {
  const d = sub2([], p, ref.pos);
  return maddN2([], d, ref.r * ref.r / magSq2(d), ref.pos);
};
export {
  invertCircle,
  invertCirclePoint
};
