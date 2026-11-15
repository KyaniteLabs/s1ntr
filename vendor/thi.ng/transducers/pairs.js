function* pairs(x) {
  for (const k in x) {
    if (x.hasOwnProperty(k)) {
      yield [k, x[k]];
    }
  }
}
export {
  pairs
};
