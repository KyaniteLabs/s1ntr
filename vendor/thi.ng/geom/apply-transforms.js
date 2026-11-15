import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { withoutKeysObj } from "@thi.ng/object-utils/without-keys";
import { __dispatch } from "./internal/dispatch.js";
import { rotateX, rotateY, rotateZ } from "./rotate-around-axis.js";
import { rotate } from "./rotate.js";
import { scale } from "./scale.js";
import { transform } from "./transform.js";
import { translate } from "./translate.js";
const TX_ATTRIBS = [
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "scale",
  "transform",
  "translate"
];
const __apply = ($) => {
  let attribs = $.attribs;
  if (!attribs) return $;
  const {
    transform: tx,
    translate: t,
    rotate: r,
    scale: s,
    rotateX: rx,
    rotateY: ry,
    rotateZ: rz
  } = attribs;
  if (tx)
    return transform(
      $.withAttribs(withoutKeysObj(attribs, TX_ATTRIBS)),
      tx
    );
  if (!(t || r || s)) return $;
  $ = $.withAttribs(withoutKeysObj(attribs, TX_ATTRIBS));
  if (r != null && $.dim === 2) $ = rotate($, r);
  if (rx != null && $.dim === 3) $ = rotateX($, rx);
  if (ry != null && $.dim === 3) $ = rotateY($, ry);
  if (rz != null && $.dim === 3) $ = rotateZ($, rz);
  if (s) $ = scale($, s);
  if (t) $ = translate($, t);
  return $;
};
const applyTransforms = defmulti(
  __dispatch,
  { group3: "group" },
  {
    [DEFAULT]: __apply,
    group: ($) => __apply($.copyTransformed((x) => applyTransforms(x)))
  }
);
export {
  applyTransforms
};
