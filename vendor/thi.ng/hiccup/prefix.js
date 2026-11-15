const formatPrefixes = (prefixes) => Object.keys(prefixes).reduce(
  (acc, k) => (acc.push(`${k}: ${prefixes[k]}`), acc),
  []
).join(" ");
export {
  formatPrefixes
};
