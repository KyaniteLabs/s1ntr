import { KdTreeMap } from "@thi.ng/geom-accel/kd-tree-map";
import { distSq2, distSq3 } from "@thi.ng/vectors/distsq";
class ATessellation {
  constructor(points = [], faces = []) {
    this.points = points;
    this.faces = faces;
  }
  points;
  faces;
  addPoints(points) {
    return points.map((p) => this.addPoint(p));
  }
  addFaces(faces) {
    this.faces.push(...faces);
    return this;
  }
  pointsForIDs(indices) {
    return indices.map((i) => this.points[i]);
  }
  pointsForFaces(faces = this.faces) {
    return faces.map((ids) => this.pointsForIDs(ids));
  }
}
class BasicTessellation extends ATessellation {
  empty() {
    return new BasicTessellation();
  }
  addPoint(p) {
    return this.points.push(p) - 1;
  }
}
class MeshTessellation extends ATessellation {
  constructor(dim, points = [], faces = [], eps = 1e-6) {
    super(points, faces);
    this.eps = eps;
    this.tree = new KdTreeMap(
      dim,
      void 0,
      dim === 2 ? distSq2 : distSq3
    );
    this.addPoints(points);
  }
  eps;
  tree;
  empty() {
    return new MeshTessellation(this.tree.dim);
  }
  addPoint(p) {
    const tree = this.tree;
    let id = tree.get(p, this.eps);
    if (id !== void 0) return id;
    id = tree.size;
    tree.set(p, id, this.eps);
    this.points.push(p);
    return id;
  }
}
export {
  ATessellation,
  BasicTessellation,
  MeshTessellation
};
