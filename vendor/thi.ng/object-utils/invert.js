const invertMap = (src, dest) => {
  dest = dest || /* @__PURE__ */ new Map();
  for (const p of src) {
    dest.set(p[1], p[0]);
  }
  return dest;
};
const invertObj = (src, dest = {}) => {
  for (const k in src) {
    dest[src[k]] = k;
  }
  return dest;
};
export {
  invertMap,
  invertObj
};
