import { unsupportedOp } from "@thi.ng/errors/unsupported";
import { LOGGER } from "./logger.js";
const DEFAULT = /* @__PURE__ */ Symbol();
function defmulti(f, _rels, _impls) {
  const impls = {};
  const rels = _rels ? __makeRels(_rels) : {};
  const fn = (...args) => {
    const id = f(...args);
    const g = impls[id] || __findImpl(impls, rels, id) || impls[DEFAULT];
    return g ? g(...args) : unsupportedOp(`missing implementation for: "${id.toString()}"`);
  };
  fn.add = (id, _impl) => {
    if (impls[id]) {
      LOGGER.warn(`overwriting '${id.toString()}' impl`);
    }
    impls[id] = _impl;
    return true;
  };
  fn.addAll = (_impls2) => {
    let ok = true;
    for (const id in _impls2) {
      ok = fn.add(id, _impls2[id]) && ok;
    }
    DEFAULT in _impls2 && fn.setDefault(_impls2[DEFAULT]);
    return ok;
  };
  fn.setDefault = (impl) => fn.add(DEFAULT, impl);
  fn.remove = (id) => {
    if (!impls[id]) return false;
    delete impls[id];
    return true;
  };
  fn.callable = (...args) => {
    const id = f(...args);
    return !!(impls[id] || __findImpl(impls, rels, id) || impls[DEFAULT]);
  };
  fn.isa = (id, parent) => {
    let val = rels[id];
    !val && (rels[id] = val = /* @__PURE__ */ new Set());
    val.add(parent);
  };
  fn.impls = () => {
    const res = /* @__PURE__ */ new Map();
    for (const id in impls) {
      res.set(id, impls[id]);
    }
    for (const id in rels) {
      const impl = __findImpl(impls, rels, id);
      if (impl) res.set(id, impl);
    }
    if (impls[DEFAULT]) {
      res.set(DEFAULT, impls[DEFAULT]);
    }
    return res;
  };
  fn.implForID = (id) => impls[String(id)] || __findImpl(impls, rels, id) || impls[DEFAULT];
  fn.rels = () => rels;
  fn.parents = (id) => rels[id];
  fn.ancestors = (id) => new Set(__findAncestors([], rels, id));
  fn.dependencies = function* () {
    for (const a in rels) {
      for (const b of rels[a]) yield [a, b];
    }
    for (const id in impls) {
      !rels[id] && (yield [id, void 0]);
    }
  };
  _impls && fn.addAll(_impls);
  return fn;
}
const __findImpl = (impls, rels, id) => {
  const parents = rels[id];
  if (!parents) return;
  for (const p of parents) {
    let impl = impls[p] || __findImpl(impls, rels, p);
    if (impl) return impl;
  }
};
const __findAncestors = (acc, rels, id) => {
  const parents = rels[id];
  if (parents) {
    for (const p of parents) {
      acc.push(p);
      __findAncestors(acc, rels, p);
    }
  }
  return acc;
};
const __makeRels = (spec) => {
  const rels = {};
  for (const k in spec) {
    const val = spec[k];
    rels[k] = val instanceof Set ? val : Array.isArray(val) ? new Set(val) : /* @__PURE__ */ new Set([val]);
  }
  return rels;
};
export {
  DEFAULT,
  defmulti
};
