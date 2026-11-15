const asObject = (src, dest = {}) => src.reduce((acc, [k, v]) => (acc[k] = v, acc), dest);
export {
  asObject
};
