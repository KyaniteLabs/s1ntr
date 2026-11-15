import { implementsFunction } from "@thi.ng/checks/implements-function";
import { isArray } from "@thi.ng/checks/is-array";
import { circle } from "./circle.js";
import { ellipse } from "./ellipse.js";
import { PRECISION, fattribs, setPrecision } from "./format.js";
import { linearGradient, radialGradient } from "./gradients.js";
import { __groupLayerID } from "./group.js";
import { image } from "./image.js";
import { hline, line, vline } from "./line.js";
import { path } from "./path.js";
import { packedPoints, points } from "./points.js";
import { polygon } from "./polygon.js";
import { polyline } from "./polyline.js";
import { roundedRect } from "./rect.js";
import { text } from "./text.js";
const ATTRIB_ALIASES = {
  alpha: "opacity",
  dash: "stroke-dasharray",
  dashOffset: "stroke-dashoffset",
  fillRule: "fill-rule",
  lineCap: "stroke-linecap",
  lineJoin: "stroke-linejoin",
  miterLimit: "stroke-miterlimit",
  weight: "stroke-width"
};
const TEXT_ALIGN = {
  left: "start",
  right: "end",
  center: "middle",
  start: "start",
  end: "end"
};
const BASE_LINE = {
  top: "text-top",
  bottom: "text-bottom"
};
const precisionStack = [];
const convertTree = (tree) => {
  if (tree == null) return null;
  if (implementsFunction(tree, "toHiccup")) {
    return convertTree(tree.toHiccup());
  }
  const type = tree[0];
  if (isArray(type)) {
    return tree.map(convertTree);
  }
  let attribs = __convertAttribs(tree[1]);
  if (attribs.__convert === false) return tree;
  if (attribs.__prec != null) {
    precisionStack.push(PRECISION);
    setPrecision(attribs.__prec);
  }
  let result;
  switch (tree[0]) {
    case "svg":
    case "defs":
    case "a":
    case "g":
      result = [type, fattribs(attribs)];
      if (tree[0] === "g") __groupLayerID(result[1]);
      for (let i = 2, n = tree.length; i < n; i++) {
        const c = convertTree(tree[i]);
        c != null && result.push(c);
      }
      break;
    case "linearGradient":
      result = linearGradient(
        attribs.id,
        attribs.from,
        attribs.to,
        tree[2],
        {
          gradientUnits: attribs.gradientUnits || "userSpaceOnUse",
          ...attribs.gradientTransform ? { gradientTransform: attribs.gradientTransform } : null
        }
      );
      break;
    case "radialGradient":
      result = radialGradient(
        attribs.id,
        attribs.from,
        attribs.to,
        attribs.r1,
        attribs.r2,
        tree[2],
        {
          gradientUnits: attribs.gradientUnits || "userSpaceOnUse",
          ...attribs.gradientTransform ? { gradientTransform: attribs.gradientTransform } : null
        }
      );
      break;
    case "circle":
      result = circle(tree[2], tree[3], attribs, ...tree.slice(4));
      break;
    case "ellipse":
      result = ellipse(
        tree[2],
        tree[3][0],
        tree[3][1],
        attribs,
        ...tree.slice(4)
      );
      break;
    case "rect": {
      const r = tree[5] ?? attribs.r ?? 0;
      result = roundedRect(
        tree[2],
        tree[3],
        tree[4],
        r,
        r,
        attribs,
        ...tree.slice(6)
      );
      break;
    }
    case "line":
      result = line(tree[2], tree[3], attribs, ...tree.slice(4));
      break;
    case "hline":
      result = hline(tree[2], attribs);
      break;
    case "vline":
      result = vline(tree[2], attribs);
      break;
    case "polyline":
      result = polyline(tree[2], attribs, ...tree.slice(3));
      break;
    case "polygon":
      result = polygon(tree[2], attribs, ...tree.slice(3));
      break;
    case "path":
      result = path(tree[2], attribs, ...tree.slice(3));
      break;
    case "text":
      result = text(tree[2], tree[3], attribs, ...tree.slice(4));
      break;
    case "img":
      result = image(tree[3], tree[2].src, attribs, ...tree.slice(4));
      break;
    case "points":
      result = points(
        tree[2],
        attribs.shape,
        attribs.size,
        attribs,
        ...tree.slice(3)
      );
      break;
    case "packedPoints":
      result = packedPoints(
        tree[2],
        attribs.shape,
        attribs.size,
        attribs,
        ...tree.slice(3)
      );
      break;
    default:
      result = tree;
  }
  if (attribs.__prec != null) {
    setPrecision(precisionStack.pop());
  }
  return result;
};
const __convertAttribs = (attribs) => {
  const res = {};
  if (!attribs) return res;
  for (const id in attribs) {
    const v = attribs[id];
    const aid = ATTRIB_ALIASES[id];
    if (aid) {
      res[aid] = v;
    } else {
      __convertAttrib(res, id, v);
    }
  }
  return res;
};
const __convertAttrib = (res, id, v) => {
  switch (id) {
    case "font": {
      const i = v.indexOf(" ");
      res["font-size"] = v.substring(0, i);
      res["font-family"] = v.substring(i + 1);
      break;
    }
    case "align":
      res["text-anchor"] = TEXT_ALIGN[v];
      break;
    case "baseline":
      res["dominant-baseline"] = BASE_LINE[v] || v;
      break;
    // case "filter":
    // TODO needs to be translated into <filter> def first
    // https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/filter
    // https://developer.mozilla.org/en-US/docs/Web/SVG/Element/filter
    // break;
    default:
      res[id] = v;
  }
};
export {
  convertTree
};
