const commonKeysMap = (a, b, out = []) => {
  for (const k of a.keys()) {
    b.has(k) && out.push(k);
  }
  return out;
};
const commonKeysObj = (a, b, out = []) => {
  for (const k in a) {
    b.hasOwnProperty(k) && out.push(k);
  }
  return out;
};
export {
  commonKeysMap,
  commonKeysObj
};
