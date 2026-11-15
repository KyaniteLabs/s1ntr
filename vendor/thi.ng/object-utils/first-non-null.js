const firstNonNullKey = (obj, keys) => {
  for (const key of keys ?? Object.keys(obj)) {
    if (obj.hasOwnProperty(key) && obj[key] != null) return key;
  }
};
export {
  firstNonNullKey
};
