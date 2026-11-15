import { mixCubic } from "@thi.ng/math/mix";
const __axisBounds = (min, max, i, pa, pb, pc, pd) => {
  min[i] = Math.min(pa, pd);
  max[i] = Math.max(pa, pd);
  const k0 = -pa + pb;
  const k1 = pa - 2 * pb + pc;
  const k2 = -pa + 3 * pb - 3 * pc + pd;
  let h = k1 * k1 - k0 * k2;
  if (h > 0) {
    h = Math.sqrt(h);
    const update = (t) => {
      if (t > 0 && t < 1) {
        const q = mixCubic(pa, pb, pc, pd, t);
        min[i] = Math.min(min[i], q);
        max[i] = Math.max(max[i], q);
      }
    };
    update(k0 / (-k1 - h));
    update(k0 / (-k1 + h));
  }
};
const cubicBounds = (a, b, c, d) => {
  const min = [];
  const max = [];
  for (let i = a.length; i-- > 0; ) {
    __axisBounds(min, max, i, a[i], b[i], c[i], d[i]);
  }
  return [min, max];
};
export {
  cubicBounds
};
