function* keys(x) {
  for (const k in x) {
    if (x.hasOwnProperty(k)) {
      yield k;
    }
  }
}
export {
  keys
};
