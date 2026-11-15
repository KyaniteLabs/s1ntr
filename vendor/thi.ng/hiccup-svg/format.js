import { isArrayLike } from "@thi.ng/checks/is-arraylike";
import { isString } from "@thi.ng/checks/is-string";
import { css } from "@thi.ng/color/css/css";
let PRECISION = 3;
const setPrecision = (n) => PRECISION = n;
const ff = (x) => x === (x | 0) ? String(x) : x.toFixed(PRECISION);
const fpoint = (p) => ff(p[0]) + "," + ff(p[1]);
const fpoints = (pts, sep = " ") => pts ? pts.map(fpoint).join(sep) : "";
const DEFAULT_NUMERIC_IDS = [
  "font-size",
  "opacity",
  "stroke-width",
  "stroke-miterlimit"
];
const __numericAttribs = (attribs, ids) => {
  let v;
  for (const id of DEFAULT_NUMERIC_IDS.concat(ids)) {
    typeof (v = attribs[id]) === "number" && (attribs[id] = ff(v));
  }
  return attribs;
};
const fattribs = (attribs, ...numericIDs) => {
  if (!attribs) return {};
  const res = __ftransforms(attribs);
  let v;
  (v = attribs.fill) && (res.fill = fcolor(v));
  (v = attribs.stroke) && (res.stroke = fcolor(v));
  return __numericAttribs(res, numericIDs);
};
const __ftransforms = (attribs) => {
  let v;
  if ((v = attribs.transform) || attribs.translate || attribs.scale != null || attribs.rotate) {
    if (v) {
      attribs.transform = !isString(v) ? `matrix(${[...v].map(ff).join(" ")})` : v;
      delete attribs.translate;
      delete attribs.rotate;
      delete attribs.scale;
    } else {
      attribs.transform = __buildTransform(attribs);
    }
  }
  return attribs;
};
const __buildTransform = (attribs) => {
  const tx = [];
  let v;
  if (v = attribs.translate) {
    tx.push(isString(v) ? v : `translate(${ff(v[0])} ${ff(v[1])})`);
    delete attribs.translate;
  }
  if (v = attribs.rotate) {
    tx.push(isString(v) ? v : `rotate(${ff(v * 180 / Math.PI)})`);
    delete attribs.rotate;
  }
  if ((v = attribs.scale) != null) {
    tx.push(
      isString(v) ? v : isArrayLike(v) ? `scale(${ff(v[0])} ${ff(v[1])})` : `scale(${ff(v)})`
    );
    delete attribs.scale;
  }
  return tx.join(" ");
};
const fcolor = (col) => isString(col) ? col[0] === "$" ? `url(#${col.substring(1)})` : col : css(col);
const withoutKeys = (src, keys) => {
  const dest = {};
  for (const k in src) {
    src.hasOwnProperty(k) && !keys.has(k) && (dest[k] = src[k]);
  }
  return dest;
};
export {
  PRECISION,
  fattribs,
  fcolor,
  ff,
  fpoint,
  fpoints,
  setPrecision,
  withoutKeys
};
