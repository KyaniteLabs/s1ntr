import { gaussianElimination } from "./solve.js";
const polynomial = (x, coeffs) => coeffs.reduce((sum, c, i) => sum + c * x ** i, 0);
const polynomialRegression = (samples, degree) => {
  const mat = [];
  const aug = [];
  for (let i = 0; i <= degree; i++) {
    const col = [];
    for (let j = 0; j <= degree; j++) {
      col.push(samples.reduce((acc, x) => acc + x[0] ** (i + j), 0));
    }
    mat.push(col);
    aug.push(samples.reduce((acc, x) => acc + x[0] ** i * x[1], 0));
  }
  mat.push(aug);
  return gaussianElimination(mat, degree + 1);
};
export {
  polynomial,
  polynomialRegression
};
