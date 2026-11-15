import { illegalArgs } from "@thi.ng/errors/illegal-arguments";
const implementations = (id, rels, ...impls) => {
  impls.length & 1 && illegalArgs("expected an even number of implementation items");
  if (rels) {
    for (const parent in rels) {
      for (const fn of rels[parent]) {
        fn.isa(id, parent);
      }
    }
  }
  for (let i = 0; i < impls.length; i += 2) {
    impls[i].add(id, impls[i + 1]);
  }
};
export {
  implementations
};
