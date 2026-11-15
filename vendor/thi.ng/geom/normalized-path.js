import { map } from "@thi.ng/transducers/map";
import { mapcat } from "@thi.ng/transducers/mapcat";
import { Path } from "./api/path.js";
import { Path3 } from "./api/path3.js";
import { asCubic } from "./as-cubic.js";
import { __copySegment } from "./internal/copy.js";
function normalizedPath(path, only) {
  return __normalizedPath(path, only);
}
const __normalizedPath = (path, only) => {
  const $normalize = (segments) => [
    ...mapcat((s) => {
      if (s.geo && (!only || only.includes(s.type))) {
        return map((c) => ({ type: "c", geo: c }), asCubic(s.geo));
      }
      return [__copySegment(s)];
    }, segments)
  ];
  return path.copyTransformed($normalize);
};
export {
  normalizedPath
};
