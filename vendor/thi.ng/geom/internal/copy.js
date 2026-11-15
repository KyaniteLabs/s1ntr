import { withoutKeysObj } from "@thi.ng/object-utils/without-keys";
import { copy, copyVectors } from "@thi.ng/vectors/copy";
const __copyAttribs = (attribs, ...exclude) => !attribs ? void 0 : exclude.length ? withoutKeysObj({ ...attribs }, exclude) : { ...attribs };
const __copyAttribsNoSamples = (x) => __copyAttribs(x.attribs, "__samples");
const __copyShape = (ctor, inst, points) => new ctor(points || copyVectors(inst.points), __copyAttribs(inst.attribs));
const __copySegment = (s) => {
  const d = { type: s.type };
  if (s.geo) d.geo = s.geo.copy();
  else if (s.point) d.point = copy(s.point);
  return d;
};
export {
  __copyAttribs,
  __copyAttribsNoSamples,
  __copySegment,
  __copyShape
};
