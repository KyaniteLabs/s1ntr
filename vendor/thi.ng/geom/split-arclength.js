import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { Sampler } from "@thi.ng/geom-resample/sampler";
import { Group } from "./api/group.js";
import { Polyline } from "./api/polyline.js";
import { asPolyline } from "./as-polyline.js";
import { __copyAttribsNoSamples as __attribs } from "./internal/copy.js";
import { __dispatch } from "./internal/dispatch.js";
import { __pointArraysAsShapes } from "./internal/points-as-shape.js";
const splitArcLength = defmulti(
  __dispatch,
  {},
  {
    [DEFAULT]: ($, d) => splitArcLength(asPolyline($)[0], d),
    group: ($, d) => {
      const groups = [];
      let curr = [];
      let currLen = 0;
      const queue = $.children.slice().reverse();
      while (queue.length) {
        const child = queue.pop();
        const polyline = asPolyline(child)[0];
        const sampler = new Sampler(polyline.points);
        const len = sampler.totalLength();
        if (currLen + len <= d) {
          curr.push(polyline);
          currLen += len;
        } else {
          const remainingLen = d - currLen;
          const [fill, next] = sampler.splitAt(remainingLen / len);
          curr.push(new Polyline(fill, __attribs(child)));
          groups.push(new Group({}, curr));
          curr = [];
          currLen = 0;
          queue.push(new Polyline(next, __attribs(child)));
        }
      }
      if (curr.length) groups.push(new Group({}, curr));
      return new Group(__attribs($), groups);
    },
    polyline: ($, d) => {
      const chunks = [];
      let pts = $.points;
      while (true) {
        const sampler = new Sampler(pts);
        const total = sampler.totalLength();
        if (total > d) {
          const parts = sampler.splitAt(d / total);
          if (!parts) break;
          chunks.push(parts[0]);
          pts = parts[1];
        } else {
          chunks.push(pts);
          break;
        }
      }
      return new Group(
        __attribs($),
        __pointArraysAsShapes(Polyline, chunks)
      );
    }
  }
);
export {
  splitArcLength
};
