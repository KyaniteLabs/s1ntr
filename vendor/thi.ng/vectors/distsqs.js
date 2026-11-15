const distSqS2 = (a, b, ia = 0, ib = 0, sa = 1, sb = 1) => {
  const dx = a[ia] - b[ib];
  const dy = a[ia + sa] - b[ib + sb];
  return dx * dx + dy * dy;
};
const distSqS3 = (a, b, ia = 0, ib = 0, sa = 1, sb = 1) => {
  const dx = a[ia] - b[ib];
  const dy = a[ia + sa] - b[ib + sb];
  const dz = a[ia + 2 * sa] - b[ib + 2 * sb];
  return dx * dx + dy * dy + dz * dz;
};
const distSqS4 = (a, b, ia = 0, ib = 0, sa = 1, sb = 1) => {
  const dx = a[ia] - b[ib];
  const dy = a[ia + sa] - b[ib + sb];
  const dz = a[ia + 2 * sa] - b[ib + 2 * sb];
  const dw = a[ia + 3 * sa] - b[ib + 3 * sb];
  return dx * dx + dy * dy + dz * dz + dw * dw;
};
const distSqS = (a, b, num, ia = 0, ib = 0, sa = 1, sb = 1) => {
  let sum = 0;
  for (let i = 0; i < num; i++) {
    const d = a[ia + i * sa] - b[ib + i * sb];
    sum += d * d;
  }
  return sum;
};
export {
  distSqS,
  distSqS2,
  distSqS3,
  distSqS4
};
