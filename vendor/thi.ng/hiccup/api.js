const PROC_TAGS = {
  "?xml": "?>\n",
  "!DOCTYPE": ">\n",
  "!ENTITY": ">\n",
  "!ELEMENT": ">\n",
  "!ATTLIST": ">\n"
};
const RE_TAG = /^([^\s.#]+)(?:#([^\s.#]+))?(?:\.([^\s#]+))?$/;
const COMMENT = "__COMMENT__";
const INLINE = "__INLINE__";
const CDATA = "!CDATA";
const DOCTYPE = "!DOCTYPE";
const XML_PROC = ["?xml", { version: "1.0", encoding: "UTF-8" }];
const DOCTYPE_HTML = [DOCTYPE, "html"];
const NO_SPANS = {
  button: 1,
  option: 1,
  script: 1,
  style: 1,
  text: 1,
  textarea: 1,
  title: 1
};
const __tagMap = (tags) => tags.split(" ").reduce((acc, x) => (acc[x] = true, acc), {});
const SVG_TAGS = __tagMap(
  "animate animateColor animateMotion animateTransform circle clipPath color-profile defs desc discard ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter font foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect set stop style svg switch symbol text textPath title tref tspan use view"
);
const VOID_TAGS = __tagMap(
  "area base br col command embed hr img input keygen link meta param source stop track use wbr ?xml"
);
const NO_CLOSE_EMPTY = __tagMap(
  "animate circle ellipse line path polygon polyline rect"
);
const ATTRIB_JOIN_DELIMS = {
  class: " ",
  accept: ",",
  sizes: ",",
  srcset: ","
};
export {
  ATTRIB_JOIN_DELIMS,
  CDATA,
  COMMENT,
  DOCTYPE,
  DOCTYPE_HTML,
  INLINE,
  NO_CLOSE_EMPTY,
  NO_SPANS,
  PROC_TAGS,
  RE_TAG,
  SVG_TAGS,
  VOID_TAGS,
  XML_PROC
};
