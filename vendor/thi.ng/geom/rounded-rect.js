import { isNumber } from "@thi.ng/checks/is-number";
import { Path } from "./api/path.js";
import { pathBuilder } from "./path-builder.js";
const roundedRect = (pos, [w, h], radii, attribs) => {
  const [tl, tr, br, bl] = isNumber(radii) ? [radii, radii, radii, radii] : radii.length === 2 ? [radii[0], radii[1], radii[0], radii[1]] : radii.length === 3 ? [radii[0], radii[1], radii[2], radii[1]] : radii;
  const b = pathBuilder(attribs).moveTo([pos[0] + tl, pos[1]]).hlineTo(w - tl - tr, true);
  if (tr > 0) b.arcTo([tr, tr], [tr, tr], 0, false, true, true);
  b.vlineTo(h - tr - br, true);
  if (br > 0) b.arcTo([-br, br], [br, br], 0, false, true, true);
  b.hlineTo(-(w - br - bl), true);
  if (bl > 0) b.arcTo([-bl, -bl], [bl, bl], 0, false, true, true);
  b.vlineTo(-(h - bl - tl), true);
  if (tl > 0) b.arcTo([tl, -tl], [tl, tl], 0, false, true, true);
  return b.current().close();
};
export {
  roundedRect
};
