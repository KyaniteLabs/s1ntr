import { lch } from "./lch/lch.js";
import { rotate } from "./rotate.js";
const $ = (src, l = 0, c = 0) => {
  src.l += l;
  src.c += c;
  return src;
};
const complementaryStrategy = (src, deltaL, deltaC) => {
  const $src = lch(src);
  return [$src, $(rotate(lch(), $src, 0.5), deltaL, deltaC)];
};
const analogStrategy = (src, theta = 1 / 12, deltaL, deltaC) => {
  const $src = lch(src);
  return [
    $src,
    $(rotate(lch(), $src, -theta), deltaL, deltaC),
    $(rotate(lch(), $src, theta), deltaL, deltaC)
  ];
};
const splitAnalogStrategy = (src, theta = 1 / 12, deltaL, deltaC) => {
  const $src = lch(src);
  return [
    ...splitComplementaryStrategy($src, theta, deltaL, deltaC),
    $(rotate(lch(), $src, theta), deltaL, deltaC)
  ];
};
const splitComplementaryStrategy = (src, theta = 1 / 12, deltaL, deltaC) => {
  const $src = lch(src);
  return [
    $src,
    $(rotate(lch(), $src, 0.5 - theta), deltaL, deltaC),
    $(rotate(lch(), $src, 0.5 + theta), deltaL, deltaC)
  ];
};
const monochromeStrategy = (src, deltaC = 0) => {
  let [_, c, h, a] = lch(src);
  c += deltaC;
  return [
    lch(0, c, h, a),
    lch(0.25, c, h, a),
    lch(0.5, c, h, a),
    lch(0.75, c, h, a),
    lch(1, c, h, a)
  ];
};
const triadicStrategy = (src, deltaL, deltaC) => splitComplementaryStrategy(src, 1 / 6, deltaL, deltaC);
const tetradicStrategy = (src, theta = 1 / 6, deltaL, deltaC) => {
  const $src = lch(src);
  return [
    $src,
    $(rotate(lch(), $src, theta), deltaL, deltaC),
    $(rotate(lch(), $src, 0.5), deltaL, deltaC),
    $(rotate(lch(), $src, 0.5 + theta), deltaL, deltaC)
  ];
};
const squareStrategy = (src, deltaL, deltaC) => tetradicStrategy(src, 0.25, deltaL, deltaC);
export {
  analogStrategy,
  complementaryStrategy,
  monochromeStrategy,
  splitAnalogStrategy,
  splitComplementaryStrategy,
  squareStrategy,
  tetradicStrategy,
  triadicStrategy
};
