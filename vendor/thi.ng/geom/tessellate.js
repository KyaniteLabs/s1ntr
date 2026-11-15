import { ensureArray } from "@thi.ng/arrays/ensure-array";
import { DEFAULT, defmulti } from "@thi.ng/defmulti/defmulti";
import { earCut } from "@thi.ng/geom-tessellate/earcut";
import {
  earCutComplex,
  earCutComplexPrepare
} from "@thi.ng/geom-tessellate/earcut-complex";
import { edgeSplit } from "@thi.ng/geom-tessellate/edge-split";
import { inset } from "@thi.ng/geom-tessellate/inset";
import { quadFan } from "@thi.ng/geom-tessellate/quad-fan";
import { rimTris } from "@thi.ng/geom-tessellate/rim-tris";
import {
  tessellateFaces,
  tessellateWith
} from "@thi.ng/geom-tessellate/tessellate";
import {
  BasicTessellation,
  MeshTessellation
} from "@thi.ng/geom-tessellate/tessellation";
import { triFan } from "@thi.ng/geom-tessellate/tri-fan";
import { triFanBoundary } from "@thi.ng/geom-tessellate/tri-fan-boundary";
import { triFanSplit } from "@thi.ng/geom-tessellate/tri-fan-split";
import { Group } from "./api/group.js";
import { __dispatch } from "./internal/dispatch.js";
import { vertices } from "./vertices.js";
const tessellate = defmulti(
  __dispatch,
  {},
  {
    [DEFAULT]: ($, fns, tess) => tessellateWith(tess || new BasicTessellation(), vertices($), fns),
    complexpoly: ($, fns, tess) => {
      const { boundary, children } = $;
      const [points, holes] = earCutComplexPrepare(
        boundary.points,
        children.map((c) => c.points)
      );
      tess = tess || new BasicTessellation();
      const faces = earCutComplex(holes)(
        tess,
        [],
        tess.addPoints(points)
      );
      fns = ensureArray(fns);
      return fns.length ? tessellateFaces(tess, faces, fns) : tess.addFaces(faces);
    },
    group: ($, fns, tess) => {
      fns = ensureArray(fns);
      tess = tess || new BasicTessellation();
      for (const child of $.children) {
        tess = tessellate(child, fns, tess);
      }
      return tess;
    }
  }
);
const TESSELLATE_EARCUT = earCut;
const TESSELLATE_EARCUT_COMPLEX = earCutComplex;
const TESSELLATE_EDGE_SPLIT = edgeSplit;
const TESSELLATE_INSET = inset;
const TESSELLATE_QUAD_FAN = quadFan;
const TESSELLATE_RIM_TRIS = rimTris;
const TESSELLATE_TRI_FAN = triFan;
const TESSELLATE_TRI_FAN_BOUNDARY = triFanBoundary;
const TESSELLATE_TRI_FAN_SPLIT = triFanSplit;
const basicTessellation = () => new BasicTessellation();
const meshTessellation = (dim, eps) => new MeshTessellation(dim, [], [], eps);
export {
  TESSELLATE_EARCUT,
  TESSELLATE_EARCUT_COMPLEX,
  TESSELLATE_EDGE_SPLIT,
  TESSELLATE_INSET,
  TESSELLATE_QUAD_FAN,
  TESSELLATE_RIM_TRIS,
  TESSELLATE_TRI_FAN,
  TESSELLATE_TRI_FAN_BOUNDARY,
  TESSELLATE_TRI_FAN_SPLIT,
  basicTessellation,
  meshTessellation,
  tessellate
};
