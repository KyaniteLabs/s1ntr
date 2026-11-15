function* cycle(input, num = Infinity) {
  if (num < 1) return;
  let cache = [];
  for (const i of input) {
    cache.push(i);
    yield i;
  }
  if (cache.length > 0) {
    while (--num > 0) {
      yield* cache;
    }
  }
}
export {
  cycle
};
