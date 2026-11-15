import { deref } from "@thi.ng/api/deref";
import { isArray } from "@thi.ng/checks/is-array";
import { isString } from "@thi.ng/checks/is-string";
const mergeClasses = (existing, val) => {
  val = deref(val);
  const $existing = existing.baseVal != void 0 ? existing.baseVal : existing;
  if (val == null) return $existing;
  if (isArray(val)) val = val.join(" ");
  if (isString(val)) return $existing ? $existing + " " + val : val;
  const classes = new Set($existing ? $existing.split(" ") : void 0);
  for (const id in val) {
    deref(val[id]) ? classes.add(id) : classes.delete(id);
  }
  return [...classes].join(" ");
};
const mergeEmmetAttribs = (attribs, id, classes) => {
  id && (attribs.id = id);
  let aclass = deref(attribs.class);
  if (classes) {
    classes = classes.replace(/\./g, " ");
    attribs.class = aclass ? mergeClasses(classes, aclass) : classes;
  } else if (aclass) {
    attribs.class = isString(aclass) ? aclass : mergeClasses("", aclass);
  }
  return attribs;
};
export {
  mergeClasses,
  mergeEmmetAttribs
};
