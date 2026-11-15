import { fromHomogeneous4 } from "@thi.ng/vectors/homogeneous";
import { invert23, invert44 } from "./invert.js";
import { mulV23, mulV344, mulV44 } from "./mulv.js";
const project = (out, mvp, view, p) => (!out && (out = []), mulV23(out, view, fromHomogeneous4(out, mulV44([], mvp, p))));
const project3 = (out, mvp, view, p) => {
  !out && (out = []);
  const q = mulV344(out, mvp, p);
  return q ? mulV23(q, view, q) : void 0;
};
const unproject = (out, mvp, view, p, doInvert = false) => {
  if (doInvert) {
    const _mvp = invert44([], mvp);
    const _view = invert23([], view);
    if (!_mvp || !_view) return;
    mvp = _mvp;
    view = _view;
  }
  return mulV344(out, mvp, mulV23([0, 0, p[2] * 2 - 1], view, p));
};
export {
  project,
  project3,
  unproject
};
