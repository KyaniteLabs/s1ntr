const isMultipleOf = (base, x, eps = 1e-6) => {
  if (x === 0) throw new Error("base must be non-zero");
  if (typeof x !== "number") return false;
  const quot = x / base;
  return Math.abs(quot - Math.round(quot)) < eps;
};
export {
  isMultipleOf
};
