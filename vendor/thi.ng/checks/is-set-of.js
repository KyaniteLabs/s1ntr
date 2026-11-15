const isSetOf = (pred) => (x) => {
  if (!(x instanceof Set)) return false;
  for (let y of x) if (!pred(y)) return false;
  return true;
};
export {
  isSetOf
};
