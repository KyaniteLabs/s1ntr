const gcd = (a, b) => {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const tmp = b;
    b = a % b;
    a = tmp;
  }
  return a;
};
const lcm = (a, b) => {
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new Error("both inputs must be finite");
  return a && b ? Math.abs(a * b) / gcd(a, b) : 0;
};
const asFraction = (x, maxDenom = 1e6) => {
  if (!Number.isFinite(x)) throw new Error("input must be a finite");
  if (Number.isInteger(x)) return [x, 1];
  const sign = Math.sign(x);
  x = Math.abs(x);
  let n0 = 0;
  let n1 = 1;
  let d0 = 1;
  let d1 = 0;
  while (true) {
    const i = Math.floor(x);
    const d2 = i * d1 + d0;
    if (d2 > maxDenom) break;
    const n2 = i * n1 + n0;
    n0 = n1;
    n1 = n2;
    d0 = d1;
    d1 = d2;
    const rem = x - i;
    if (rem < Number.EPSILON) break;
    x = 1 / rem;
  }
  return [sign * n1, d1];
};
const asFloat = ([a, b]) => a / b;
export {
  asFloat,
  asFraction,
  gcd,
  lcm
};
