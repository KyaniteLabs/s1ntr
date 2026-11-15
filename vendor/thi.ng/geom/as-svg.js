import { convertTree } from "@thi.ng/hiccup-svg/convert";
import { ff } from "@thi.ng/hiccup-svg/format";
import { svg } from "@thi.ng/hiccup-svg/svg";
import { serialize } from "@thi.ng/hiccup/serialize";
import { withoutKeysObj } from "@thi.ng/object-utils/without-keys";
import { bounds } from "./bounds.js";
import { __collBounds } from "./internal/bounds.js";
let SVG_DEFAULT_ATTRIBS = {
  __prec: 3,
  fill: "none",
  stroke: "#000"
};
const setSvgDefaultAttribs = (attribs, merge = false) => {
  SVG_DEFAULT_ATTRIBS = merge ? { ...SVG_DEFAULT_ATTRIBS, ...attribs } : attribs;
};
const asSvg = (...args) => args.map((x) => serialize(convertTree(x))).join("");
const svgDoc = (attribs, ...shapes) => {
  let $attribs = { ...SVG_DEFAULT_ATTRIBS, ...attribs };
  if (shapes.length > 0) {
    if (!$attribs.viewBox) {
      const cbounds = __collBounds(shapes, bounds);
      if (cbounds) {
        const [[x, y], [w, h]] = cbounds;
        const margin = $attribs.__margin || 0;
        const width = ff(w + 2 * margin);
        const height = ff(h + 2 * margin);
        $attribs = {
          width,
          height,
          viewBox: `${ff(x - margin)} ${ff(
            y - margin
          )} ${width} ${height}`,
          ...withoutKeysObj($attribs, ["__margin"])
        };
      }
    }
  }
  return svg($attribs, ...shapes);
};
export {
  SVG_DEFAULT_ATTRIBS,
  asSvg,
  setSvgDefaultAttribs,
  svgDoc
};
