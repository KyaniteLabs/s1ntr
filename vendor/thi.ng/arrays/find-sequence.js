function findSequence(buf, needle, start = 0) {
  const m = buf.length;
  const n = needle.length;
  const max = m - n;
  if (!n || max < 0) return -1;
  while (start < m) {
    const idx = buf.indexOf(needle[0], start);
    if (idx < 0 || idx > max) return -1;
    let j = n;
    while (j-- > 1) {
      if (buf[idx + j] !== needle[j]) {
        start = idx + 1;
        break;
      }
    }
    if (j === 0) return idx;
  }
  return -1;
}
function findLastSequence(buf, needle, start = buf.length - 1) {
  const m = buf.length;
  const n = needle.length;
  if (!n || n > m) return -1;
  start = Math.min(start, m - n);
  let j;
  for (let i = start; i >= 0; i--) {
    for (j = n; j-- > 0; ) {
      if (buf[i + j] !== needle[j]) break;
    }
    if (j < 0) return i;
  }
  return -1;
}
export {
  findLastSequence,
  findSequence
};
