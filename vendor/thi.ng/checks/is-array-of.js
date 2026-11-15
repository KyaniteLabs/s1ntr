const isArrayOf = (pred) => (x) => Array.isArray(x) && x.every(pred);
export {
  isArrayOf
};
