import { ensureIterable } from "@thi.ng/arrays/ensure-iterable";
function* concat(...sources) {
  for (const src of sources) {
    src != null && (yield* ensureIterable(src));
  }
}
export {
  concat
};
