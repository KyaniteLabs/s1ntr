import { describe, expect, it } from 'vitest';
import { renderKitPiece } from './kitRender.js';

const CODE = `
import * as THREE from "three";
import { MeshBVH, acceleratedRaycast, computeBoundsTree } from "three-mesh-bvh";
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101828);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100); camera.position.z = 4;
const geo = new THREE.TorusKnotGeometry(1, 0.35, 200, 32); geo.computeBoundsTree();
const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff7733 })); scene.add(mesh);
mesh.updateMatrixWorld(); let hit = []; for (let x = -2; x <= 2; x += 0.25) hit = hit.concat(new THREE.Raycaster(new THREE.Vector3(x, 0, 5), new THREE.Vector3(0, 0, -1)).intersectObject(mesh));
console.log('bvh-hits:' + hit.length + ' ' + (geo.boundsTree instanceof MeshBVH));
const r = new THREE.WebGLRenderer({ preserveDrawingBuffer: true }); r.setSize(innerWidth, innerHeight);
document.body.appendChild(r.domElement); r.render(scene, camera);
`;

describe('three-mesh-bvh through the real harness', () => {
  it('a piece using it renders non-blank and the BVH answers a raycast', async () => {
    const { result, analysis } = await renderKitPiece(CODE, 'three', ['three-mesh-bvh']);
    expect(result.success, result.error).toBe(true);
    expect(result.logs.join('\n')).toMatch(/bvh-hits:[1-9]\d* true/);
    expect(analysis?.hasVisibleContent).toBe(true);
  }, 90_000);
});
