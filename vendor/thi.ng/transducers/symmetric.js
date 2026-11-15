function* symmetric(src) {
  let head = void 0;
  for (const x of src) {
    head = { x, n: head };
    yield x;
  }
  while (head) {
    yield head.x;
    head = head.n;
  }
}
export {
  symmetric
};
