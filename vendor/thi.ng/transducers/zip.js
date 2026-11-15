function* zip(...src) {
  const iters = src.map((s) => s[Symbol.iterator]());
  while (true) {
    const tuple = [];
    for (const i of iters) {
      let v = i.next();
      if (v.done) {
        return;
      }
      tuple.push(v.value);
    }
    yield tuple;
  }
}
export {
  zip
};
