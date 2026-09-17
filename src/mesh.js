import * as THREE from 'three';

/**
 * Build a displaced grid mesh from a depth map + photo texture.
 * UVs match the image; depth displaces along -Z (into the scene).
 *
 * @param {HTMLImageElement} image
 * @param {{ width: number, height: number, data: Float32Array }} depthMap
 * @param {object} [opts]
 * @returns {THREE.Mesh}
 */
export function buildDepthMesh(image, depthMap, opts = {}) {
  const {
    maxSize = 8, // world units for the longer side of the image plane
    depthScale = 4.5, // how far "into" the room depth pushes
    segments = 192, // grid resolution (higher = smoother, slower)
  } = opts;

  const imgW = image.naturalWidth || image.width;
  const imgH = image.naturalHeight || image.height;
  const aspect = imgW / imgH;

  let planeW;
  let planeH;
  if (aspect >= 1) {
    planeW = maxSize;
    planeH = maxSize / aspect;
  } else {
    planeH = maxSize;
    planeW = maxSize * aspect;
  }

  // Cap segment count by depth map size for quality
  const segX = Math.min(segments, depthMap.width);
  const segY = Math.min(segments, depthMap.height);

  const geometry = new THREE.PlaneGeometry(planeW, planeH, segX, segY);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;

  // Sample depth at each vertex UV and displace along -Z
  for (let i = 0; i < pos.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    // Image UV: v=0 bottom in Three.js PlaneGeometry; depth map row 0 is top
    const dx = Math.min(depthMap.width - 1, Math.max(0, Math.floor(u * (depthMap.width - 1))));
    const dy = Math.min(
      depthMap.height - 1,
      Math.max(0, Math.floor((1 - v) * (depthMap.height - 1)))
    );
    const d = depthMap.data[dy * depthMap.width + dx];
    // Near (d~1) stays closer to camera (z closer to 0); far pushes back
    // Place plane centered at z = -depthScale/2 so room surrounds walk start
    const z = -d * depthScale;
    pos.setZ(i, z);
  }

  pos.needsUpdate = true;
  geometry.computeVertexNormals();

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Lift so approximate "floor" of the photo sits near y=0
  // Camera eye height ~1.6; plane center at eye height for looking into photo
  mesh.position.set(0, 1.55, 0);
  mesh.userData = {
    planeW,
    planeH,
    depthScale,
    // Suggested spawn: a bit in front of the mesh looking at it
    spawn: new THREE.Vector3(0, 1.6, depthScale * 0.15 + 0.8),
  };

  return mesh;
}
