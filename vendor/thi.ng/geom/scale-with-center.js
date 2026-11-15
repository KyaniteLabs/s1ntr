import { mulN } from "@thi.ng/vectors/muln";
import { scale } from "./scale.js";
import { translate } from "./translate.js";
const scaleWithCenter = (shape, center, factor) => translate(scale(translate(shape, mulN([], center, -1)), factor), center);
export {
  scaleWithCenter
};
