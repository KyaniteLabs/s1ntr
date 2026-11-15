import { ceilPow2 } from "@thi.ng/binary/pow";
const treeToMorton = (t, dim) => {
  let n = 0;
  let m = 0;
  let l = t.length;
  dim = 1 << dim;
  while (l-- > 0) {
    m += (t[l] - 1) * Math.pow(dim, n);
    n++;
  }
  return m + 1;
};
const mortonToTree = (m, dim) => {
  const t = [];
  dim = 1 << dim;
  while (true) {
    m--;
    const d = (m / dim | 0) + 1;
    const r = m % dim + 1;
    t.unshift(r);
    if (d === 1) break;
    m = d;
  }
  return t;
};
const treeToCartesian = (t, dim) => {
  const c = [];
  for (let i = 0, x = t[0] - 1; i < dim; i++) {
    c[i] = (x >>> i & 1) + 1;
  }
  if (t.length < 2) return c;
  const cn = treeToCartesian(t.slice(1), dim);
  const m = 1 << t.length - 1;
  const res = new Array(dim);
  for (let i = 0; i < dim; i++) {
    res[i] = m * (c[i] - 1) + cn[i];
  }
  return res;
};
const cartesianToTree = (v) => {
  const $ = (v2, half) => {
    const t = v2.reduce((t2, x, i) => t2 + (1 << i) * (x > half), 1);
    return half > 1 ? [
      t,
      ...$(
        v2.map((x) => (x - 1) % half + 1),
        half >>> 1
      )
    ] : [t];
  };
  return $(v, Math.max(2, ceilPow2(Math.max(...v))) >>> 1);
};
export {
  cartesianToTree,
  mortonToTree,
  treeToCartesian,
  treeToMorton
};
