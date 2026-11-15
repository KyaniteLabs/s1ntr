import { deref, isDeref } from "@thi.ng/api/deref";
import { implementsFunction } from "@thi.ng/checks/implements-function";
import { isArray } from "@thi.ng/checks/is-array";
import { isFunction } from "@thi.ng/checks/is-function";
import { isNotStringAndIterable } from "@thi.ng/checks/is-not-string-iterable";
import { isPlainObject } from "@thi.ng/checks/is-plain-object";
import { isString } from "@thi.ng/checks/is-string";
import { illegalArgs } from "@thi.ng/errors/illegal-arguments";
import { escapeEntitiesNum } from "@thi.ng/strings/entities";
import {
  ATTRIB_JOIN_DELIMS,
  CDATA,
  COMMENT,
  INLINE,
  NO_CLOSE_EMPTY,
  NO_SPANS,
  PROC_TAGS,
  VOID_TAGS
} from "./api.js";
import { css } from "./css.js";
import { normalize } from "./normalize.js";
import { formatPrefixes } from "./prefix.js";
const serialize = (tree, opts, path = [0]) => {
  const $opts = {
    escape: false,
    escapeFn: escapeEntitiesNum,
    keys: false,
    span: false,
    xml: false,
    ...opts
  };
  if (opts?.keys == null && $opts.span) $opts.keys = true;
  return __serialize(tree, $opts, path);
};
const __serialize = (tree, opts, path) => tree == null ? "" : Array.isArray(tree) ? __serializeElement(tree, opts, path) : isFunction(tree) ? __serialize(tree(opts.ctx), opts, path) : implementsFunction(tree, "toHiccup") ? __serialize(tree.toHiccup(opts.ctx), opts, path) : isDeref(tree) ? __serialize(tree.deref(), opts, path) : isNotStringAndIterable(tree) ? __serializeIter(tree, opts, path) : (tree = __escape(String(tree), opts), opts.span) ? `<span${opts.keys ? ` key="${path.join("-")}"` : ""}>${tree}</span>` : tree;
const __serializeElement = (tree, opts, path) => {
  let tag = tree[0];
  return !tree.length ? "" : isFunction(tag) ? __serialize(
    tag.apply(null, [opts.ctx, ...tree.slice(1)]),
    opts,
    path
  ) : implementsFunction(tag, "render") ? __serialize(
    tag.render.apply(null, [opts.ctx, ...tree.slice(1)]),
    opts,
    path
  ) : tag === COMMENT ? __serializeComment(tree) : tag === INLINE ? __serializeInline(tree) : tag == CDATA ? __serializeCData(tree) : isString(tag) ? __serializeTag(tree, opts, path) : isNotStringAndIterable(tree) ? __serializeIter(tree, opts, path) : illegalArgs(`invalid tree node: ${tree}`);
};
const __serializeTag = (tree, opts, path) => {
  tree = normalize(tree);
  const attribs = tree[1];
  if (attribs.__skip || attribs.__serialize === false) return "";
  opts.keys && attribs.key === void 0 && (attribs.key = path.join("-"));
  if (attribs.__escape != null) opts = { ...opts, escape: attribs.__escape };
  const tag = tree[0];
  let body = tree[2];
  if (body == null && tag === "textarea" && attribs.value) {
    body = attribs.value;
    attribs.value = void 0;
  }
  body = body != null ? __serializeBody(tag, body, opts, path) : !VOID_TAGS[tag] && !NO_CLOSE_EMPTY[tag] ? `></${tag}>` : PROC_TAGS[tag] || "/>";
  return `<${tag}${__serializeAttribs(attribs, opts)}${body}`;
};
const __serializeAttribs = (attribs, opts) => {
  let res = "";
  for (const a in attribs) {
    if (a.startsWith("__")) continue;
    const v = __serializeAttrib(attribs, a, deref(attribs[a]), opts);
    v != null && (res += v);
  }
  return res;
};
const __serializeAttrib = (attribs, a, v, opts) => {
  return v == null ? null : isFunction(v) && (/^on\w+/.test(a) || (v = v(attribs)) == null) ? null : v === true ? " " + a + (opts.xml ? `=""` : "") : v === false ? null : a === "data" ? __serializeDataAttribs(v, opts) : __attribPair(a, v, opts);
};
const __attribPair = (a, v, opts) => {
  v = a === "style" && isPlainObject(v) ? css(v) : a === "prefix" && isPlainObject(v) ? formatPrefixes(v) : isArray(v) ? v.join(ATTRIB_JOIN_DELIMS[a] || " ") : v.toString();
  return v.length ? ` ${a}="${__escape(v, opts)}"` : null;
};
const __serializeDataAttribs = (data, opts) => {
  let res = "";
  for (const id in data) {
    let v = deref(data[id]);
    isFunction(v) && (v = v(data));
    v != null && (res += ` data-${id}="${__escape(v, opts)}"`);
  }
  return res;
};
const __serializeBody = (tag, body, opts, path) => {
  if (VOID_TAGS[tag]) {
    illegalArgs(`No body allowed in tag: ${tag}`);
  }
  const proc = PROC_TAGS[tag];
  let res = proc ? " " : ">";
  if (opts.span && !proc && !NO_SPANS[tag]) opts = { ...opts, span: true };
  for (let i = 0, n = body.length; i < n; i++) {
    res += __serialize(body[i], opts, [...path, i]);
  }
  return res + (proc || `</${tag}>`);
};
const __serializeComment = (tree) => tree.length > 2 ? `
<!--
${tree.slice(1).map((x) => "    " + x).join("\n")}
-->
` : `
<!-- ${tree[1]} -->
`;
const __serializeInline = (tree) => tree.slice(1).join("");
const __serializeCData = (tree) => `<![CDATA[
${tree.slice(1).join("\n")}
]]>`;
const __serializeIter = (iter, opts, path) => {
  const res = [];
  const p = path.slice(0, path.length - 1);
  let k = 0;
  for (const i of iter) {
    res.push(__serialize(i, opts, [...p, k++]));
  }
  return res.join("");
};
const __escape = (x, opts) => opts.escape ? opts.escapeFn(x) : x;
export {
  serialize
};
