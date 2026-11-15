import { illegalState } from "@thi.ng/errors/illegal-state";
import { rad } from "@thi.ng/math/angle";
import { WS } from "@thi.ng/strings/groups";
import { pathBuilder } from "./path-builder.js";
const CMD_RE = /[achlmqstvz]/i;
const WSC = { ...WS, ",": true };
const pathFromSvg = (svg, attribs) => {
  const b = pathBuilder(attribs);
  try {
    let cmd = "";
    for (let n = svg.length, i = 0; i < n; ) {
      i = __skipWS(svg, i);
      const c = svg.charAt(i);
      if (CMD_RE.test(c)) {
        cmd = c;
        i++;
      }
      let p, pa, pb, t1, t2, t3;
      switch (cmd.toLowerCase()) {
        case "m":
          [p, i] = __readPoint(svg, i);
          b.moveTo(p, cmd === "m");
          break;
        case "l":
          [p, i] = __readPoint(svg, i);
          b.lineTo(p, cmd === "l");
          break;
        case "h":
          [p, i] = __readFloat(svg, i);
          b.hlineTo(p, cmd === "h");
          break;
        case "v":
          [p, i] = __readFloat(svg, i);
          b.vlineTo(p, cmd === "v");
          break;
        case "q":
          [pa, i] = __readPoint(svg, i);
          [p, i] = __readPoint(svg, i);
          b.quadraticTo(pa, p, cmd === "q");
          break;
        case "c":
          [pa, i] = __readPoint(svg, i);
          [pb, i] = __readPoint(svg, i);
          [p, i] = __readPoint(svg, i);
          b.cubicTo(pa, pb, p, cmd === "c");
          break;
        case "s":
          [pa, i] = __readPoint(svg, i);
          [p, i] = __readPoint(svg, i);
          b.cubicChainTo(pa, p, cmd === "s");
          break;
        case "t":
          [p, i] = __readPoint(svg, i);
          b.quadraticChainTo(p, cmd === "t");
          break;
        case "a": {
          [pa, i] = __readPoint(svg, i);
          [t1, i] = __readFloat(svg, i);
          [t2, i] = __readFlag(svg, i);
          [t3, i] = __readFlag(svg, i);
          [pb, i] = __readPoint(svg, i);
          b.arcTo(pb, pa, rad(t1), t2, t3, cmd === "a");
          break;
        }
        case "z":
          b.close();
          break;
        default:
          throw new Error(
            `unsupported segment type: ${c} @ pos ${i}`
          );
      }
    }
    const [main, ...subPaths] = b.paths;
    return main.addSubPaths(...subPaths.map((p) => p.segments));
  } catch (e) {
    throw e instanceof Error ? e : new Error(`illegal char '${svg.charAt(e)}' @ ${e}`);
  }
};
const __skipWS = (src, i) => {
  const n = src.length;
  while (i < n && WSC[src.charAt(i)]) i++;
  return i;
};
const __readPoint = (src, index) => {
  let x, y;
  [x, index] = __readFloat(src, index);
  index = __skipWS(src, index);
  [y, index] = __readFloat(src, index);
  return [[x, y], index];
};
const __readFlag = (src, i) => {
  i = __skipWS(src, i);
  const c = src.charAt(i);
  return [
    c === "0" ? false : c === "1" ? true : illegalState(`expected '0' or '1' @ pos: ${i}`),
    i + 1
  ];
};
const __readFloat = (src, index) => {
  index = __skipWS(src, index);
  let signOk = true;
  let dotOk = true;
  let expOk = false;
  let commaOk = false;
  let i = index;
  for (let n = src.length; i < n; i++) {
    const c = src.charAt(i);
    if ("0" <= c && c <= "9") {
      expOk = true;
      commaOk = true;
      signOk = false;
      continue;
    }
    if (c === "-" || c === "+") {
      if (!signOk) break;
      signOk = false;
      continue;
    }
    if (c === ".") {
      if (!dotOk) break;
      dotOk = false;
      continue;
    }
    if (c === "e") {
      if (!expOk) throw i;
      expOk = false;
      dotOk = false;
      signOk = true;
      continue;
    }
    if (c === ",") {
      if (!commaOk) throw i;
      i++;
    }
    break;
  }
  if (i === index) {
    illegalState(`expected coordinate @ pos: ${i}`);
  }
  return [parseFloat(src.substring(index, i)), i];
};
export {
  pathFromSvg
};
