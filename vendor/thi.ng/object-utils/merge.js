const mergeMap = (dest, ...maps) => {
  for (const x of maps) {
    if (x != null) {
      for (const pair of x) {
        dest.set(pair[0], pair[1]);
      }
    }
  }
  return dest;
};
const mergeObj = (dest, ...objects) => Object.assign(dest, ...objects);
export {
  mergeMap,
  mergeObj
};
