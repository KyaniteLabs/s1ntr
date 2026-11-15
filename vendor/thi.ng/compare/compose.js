const composeComparators = (cmp, ...xs) => {
  const [cmp2, cmp3, cmp4] = xs;
  switch (xs.length) {
    case 0:
      return cmp;
    case 1:
      return (a, b) => cmp(a, b) || cmp2(a, b);
    case 2:
      return (a, b) => cmp(a, b) || cmp2(a, b) || cmp3(a, b);
    case 3:
      return (a, b) => cmp(a, b) || cmp2(a, b) || cmp3(a, b) || cmp4(a, b);
    default: {
      const fns = [cmp, ...xs];
      const n = fns.length;
      return (a, b) => {
        for (let i = 0; i < n; i++) {
          const res = fns[i](a, b);
          if (res !== 0) return res;
        }
        return 0;
      };
    }
  }
};
export {
  composeComparators
};
