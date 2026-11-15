import { ensureArray } from "@thi.ng/arrays/ensure-array";
import { equiv } from "@thi.ng/equiv";
import { __copyAttribs } from "../internal/copy.js";
class Group {
  constructor(attribs, children) {
    this.attribs = attribs;
    this.children = children ? ensureArray(children) : [];
  }
  attribs;
  type = "group";
  dim = 2;
  children;
  *[Symbol.iterator]() {
    yield* this.children;
  }
  /**
   * Appends given `shapes` to this {@link Group.children} array.
   *
   * @param shapes
   */
  add(...shapes) {
    this.children.push(...shapes);
    return this;
  }
  /**
   * Removes all children from the group.
   */
  clear() {
    this.children.length = 0;
  }
  copy() {
    return this.copyTransformed((c) => c.copy());
  }
  copyTransformed(fn) {
    return new Group(__copyAttribs(this.attribs), this.children.map(fn));
  }
  withAttribs(attribs) {
    return new Group(attribs, this.children);
  }
  equiv(o) {
    return o instanceof Group && equiv(this.attribs, o.attribs) && equiv(this.children, o.children);
  }
  toHiccup() {
    return ["g", this.attribs, ...this.children.map((x) => x.toHiccup())];
  }
}
export {
  Group
};
