import { fattribs, ff, withoutKeys } from "./format.js";
const points = (pts, shape, size = 1, attribs, ...body) => {
  const group = [
    "g",
    fattribs(withoutKeys(attribs ?? {}, /* @__PURE__ */ new Set(["shape", "size"]))),
    ...body
  ];
  const href = __buildSymbol(group, shape, size);
  for (const p of pts) {
    group.push(["use", { "xlink:href": href, x: ff(p[0]), y: ff(p[1]) }]);
  }
  return group;
};
const packedPoints = (pts, shape, size = 1, attribs, ...body) => {
  attribs = {
    start: 0,
    cstride: 1,
    estride: 2,
    ...attribs
  };
  const { start, cstride, estride } = attribs;
  let num = attribs?.num ?? (pts.length - start) / estride | 0;
  const group = [
    "g",
    fattribs(
      withoutKeys(
        attribs,
        /* @__PURE__ */ new Set(["start", "cstride", "estride", "shape", "size", "num"])
      )
    ),
    ...body
  ];
  const href = __buildSymbol(group, shape, size);
  for (let i = start; num-- > 0; i += estride) {
    group.push([
      "use",
      { "xlink:href": href, x: ff(pts[i]), y: ff(pts[i + cstride]) }
    ]);
  }
  return group;
};
const __buildSymbol = (group, shape, size) => {
  let href;
  if (!shape || shape[0] !== "#") {
    href = "_" + (Math.random() * 1e6 | 0).toString(36);
    group.push(["g", { opacity: 0 }, __buildShape(shape, href, size)]);
    href = "#" + href;
  } else {
    href = shape;
  }
  return href;
};
const __buildShape = (shape, id, r) => {
  const rf = ff(r);
  if (shape === "circle") {
    return ["circle", { id, cx: 0, cy: 0, r: rf }];
  }
  const rf2 = ff(-r / 2);
  return ["rect", { id, x: rf2, y: rf2, width: rf, height: rf }];
};
export {
  packedPoints,
  points
};
