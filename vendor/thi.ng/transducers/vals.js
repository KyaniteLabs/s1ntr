function* vals(x) {
  for (const k in x) {
    if (x.hasOwnProperty(k)) {
      yield x[k];
    }
  }
}
export {
  vals
};
