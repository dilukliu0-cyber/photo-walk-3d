import * as THREE from 'three';

const MAX_PHOTO_EDGE = 1280;

/**
 * Read a File as raw base64 (no data: prefix) + mimeType.
 * @param {File} file
 * @returns {Promise<{ imageBase64: string, mimeType: string }>}
 */
export function fileToBase64Payload(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.size) {
      reject(
        new Error(
          'Не удалось прочитать фото. Если это HEIC/iPhone — сохрани как JPG/PNG.'
        )
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      const imageBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      const mimeMatch = /^data:([^;]+);base64,/i.exec(result);
      const mimeType = mimeMatch?.[1] || file.type || 'image/jpeg';
      resolve({ imageBase64, mimeType });
    };
    reader.onerror = () =>
      reject(
        new Error(
          'Не удалось прочитать фото. Если это HEIC/iPhone — сохрани как JPG/PNG.'
        )
      );
    reader.readAsDataURL(file);
  });
}

/**
 * Decode File → optionally resize longest edge → JPEG/PNG base64 payload for Gemini.
 * @param {File} file
 * @param {{ maxEdge?: number }} [opts]
 * @returns {Promise<{ imageBase64: string, mimeType: string, image: HTMLImageElement }>}
 */
export async function preparePhotoPayload(file, opts = {}) {
  const maxEdge = opts.maxEdge || MAX_PHOTO_EDGE;
  const image = await loadImageElement(file);
  const w = image.naturalWidth || image.width || 1;
  const h = image.naturalHeight || image.height || 1;
  const scale = Math.min(1, maxEdge / Math.max(w, h));

  if (scale >= 0.999) {
    const payload = await fileToBase64Payload(file);
    return { ...payload, image };
  }

  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const payload = await fileToBase64Payload(file);
    return { ...payload, image };
  }
  ctx.drawImage(image, 0, 0, tw, th);
  const mimeType = 'image/jpeg';
  const dataUrl = canvas.toDataURL(mimeType, 0.88);
  const comma = dataUrl.indexOf(',');
  const imageBase64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { imageBase64, mimeType, image };
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.size) {
      reject(
        new Error(
          'Не удалось прочитать фото. Если это HEIC/iPhone — сохрани как JPG/PNG.'
        )
      );
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          'Не удалось прочитать фото. Если это HEIC/iPhone — сохрани как JPG/PNG.'
        )
      );
    };
    img.src = url;
  });
}

/**
 * POST photo to Vite middleware /api/scene
 * @param {{ imageBase64: string, mimeType: string }} payload
 * @returns {Promise<{ scene: object, model: string }>}
 */
export async function fetchGeminiScene(payload) {
  const res = await fetch('/api/scene', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageBase64: payload.imageBase64,
      mimeType: payload.mimeType,
    }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `Сервер вернул не-JSON (HTTP ${res.status}). Перезапустите Vite.`
    );
  }
  if (!res.ok || data?.error) {
    throw new Error(data?.error || `Ошибка API сцены (HTTP ${res.status})`);
  }
  if (!data?.scene) {
    throw new Error('Пустой ответ Gemini — нет поля scene.');
  }
  return data;
}

function parseColor(hex, fallback = 0x888888) {
  if (typeof hex !== 'string') return fallback;
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(n) ? n : fallback;
}

function makeShapeGeometry(obj) {
  const w = Math.max(0.05, Number(obj.w) || 0.5);
  const h = Math.max(0.05, Number(obj.h) || 0.5);
  const d = Math.max(0.05, Number(obj.d) || 0.5);
  const shape = String(obj.shape || 'box').toLowerCase();
  if (shape === 'sphere') {
    const r = Math.max(w, h, d) * 0.5;
    return new THREE.SphereGeometry(r, 24, 16);
  }
  if (shape === 'cylinder') {
    const r = Math.max(w, d) * 0.5;
    return new THREE.CylinderGeometry(r, r, h, 20);
  }
  return new THREE.BoxGeometry(w, h, d);
}

function polygonAABB(polygon) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const pt of polygon) {
    const x = Number(pt?.[0]) || 0;
    const z = Number(pt?.[1]) || 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) {
    return { minX: -4, maxX: 4, minZ: -4, maxZ: 4 };
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Floor mesh from XZ polygon (y-up). Uses ShapeGeometry.
 */
function buildFloorMesh(floorSpec) {
  const polygon = Array.isArray(floorSpec?.polygon) ? floorSpec.polygon : [];
  const y = Number(floorSpec?.y) || 0;
  const color = parseColor(floorSpec?.color, 0x666666);

  if (polygon.length >= 3) {
    const shape = new THREE.Shape();
    const p0 = polygon[0];
    shape.moveTo(Number(p0[0]) || 0, Number(p0[1]) || 0);
    for (let i = 1; i < polygon.length; i++) {
      shape.lineTo(Number(polygon[i][0]) || 0, Number(polygon[i][1]) || 0);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    // ShapeGeometry is in XY; rotate to XZ
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.receiveShadow = true;
    mesh.name = 'floor';
    return mesh;
  }

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8),
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      metalness: 0.04,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  mesh.name = 'floor';
  return mesh;
}

/**
 * Wall as a box between (x1,z1)-(x2,z2).
 * If usePhoto, apply photo texture (SRGB).
 */
function buildWallMesh(wall, photoTexture, floorY) {
  const x1 = Number(wall.x1) || 0;
  const z1 = Number(wall.z1) || 0;
  const x2 = Number(wall.x2) || 0;
  const z2 = Number(wall.z2) || 0;
  const height = Math.max(0.2, Number(wall.height) || 2.8);
  const thickness = Math.max(0.05, Number(wall.thickness) || 0.15);
  const dx = x2 - x1;
  const dz = z2 - z1;
  const length = Math.hypot(dx, dz) || 0.1;
  const midX = (x1 + x2) * 0.5;
  const midZ = (z1 + z2) * 0.5;
  const angle = Math.atan2(dz, dx);

  const geo = new THREE.BoxGeometry(length, height, thickness);
  let mat;
  if (wall.usePhoto && photoTexture) {
    mat = new THREE.MeshStandardMaterial({
      map: photoTexture,
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
  } else {
    mat = new THREE.MeshStandardMaterial({
      color: parseColor(wall.color, 0xcccccc),
      roughness: 0.88,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(midX, floorY + height * 0.5, midZ);
  mesh.rotation.y = -angle;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = wall.usePhoto ? 'wall-photo' : 'wall';
  return mesh;
}

/**
 * Clear previous Gemini-built group from the scene.
 * @param {THREE.Scene} scene
 * @param {THREE.Object3D|null} group
 */
export function disposeSceneGroup(scene, group) {
  if (!group || !scene) return;
  scene.remove(group);
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
  });
}

/**
 * Build full walkable constructed 3D scene: floor polygon, walls (photo on wall),
 * indoor ceiling, props. No floating photo billboard as sole content.
 *
 * @param {THREE.Scene} scene
 * @param {object} sceneData
 * @param {HTMLImageElement} image
 * @returns {{
 *   group: THREE.Group,
 *   spawn: THREE.Vector3,
 *   lookTarget: THREE.Vector3,
 *   bounds: { minX: number, maxX: number, minZ: number, maxZ: number },
 *   title: string,
 *   summary: string
 * }}
 */
export function buildGeminiScene(scene, sceneData, image) {
  const data = sceneData || {};
  const group = new THREE.Group();
  group.name = 'gemini-scene';

  const sky = parseColor(data.skyColor, 0x87ceeb);
  scene.background = new THREE.Color(sky);
  const fogDensity = data.sceneType === 'outdoor' ? 0.012 : 0.004;
  scene.fog = new THREE.FogExp2(sky, fogDensity);

  const floorSpec = data.floor || {};
  const floorY = Number(floorSpec.y) || 0;
  const polygon = Array.isArray(floorSpec.polygon) ? floorSpec.polygon : [];
  const aabb = polygonAABB(
    polygon.length >= 3 ? polygon : [[-4, -4], [4, -4], [4, 4], [-4, 4]]
  );

  group.add(buildFloorMesh(floorSpec));

  const spanX = Math.max(2, aabb.maxX - aabb.minX);
  const spanZ = Math.max(2, aabb.maxZ - aabb.minZ);
  const gridSize = Math.max(spanX, spanZ);
  const grid = new THREE.GridHelper(
    gridSize,
    Math.min(40, Math.round(gridSize)),
    0xffffff,
    0x444444
  );
  grid.position.set(
    (aabb.minX + aabb.maxX) * 0.5,
    floorY + 0.01,
    (aabb.minZ + aabb.maxZ) * 0.5
  );
  grid.material.opacity = 0.18;
  grid.material.transparent = true;
  group.add(grid);

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.anisotropy = 8;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const walls = Array.isArray(data.walls) ? data.walls : [];
  let photoLook = null;
  for (const wall of walls) {
    if (!wall) continue;
    const mesh = buildWallMesh(wall, texture, floorY);
    group.add(mesh);
    if (wall.usePhoto) {
      photoLook = new THREE.Vector3(
        ((Number(wall.x1) || 0) + (Number(wall.x2) || 0)) * 0.5,
        floorY + Math.min((Number(wall.height) || 2.8) * 0.55, 1.6),
        ((Number(wall.z1) || 0) + (Number(wall.z2) || 0)) * 0.5
      );
    }
  }

  const ceilingH = Math.max(1.5, Number(data.ceilingHeight) || 2.8);
  if (data.sceneType !== 'outdoor') {
    const ceilW = spanX + 0.3;
    const ceilD = spanZ + 0.3;
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(ceilW, ceilD),
      new THREE.MeshStandardMaterial({
        color: 0xe8e4dc,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
      })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(
      (aabb.minX + aabb.maxX) * 0.5,
      floorY + ceilingH,
      (aabb.minZ + aabb.maxZ) * 0.5
    );
    ceiling.receiveShadow = true;
    ceiling.name = 'ceiling';
    group.add(ceiling);
  }

  const objects = Array.isArray(data.objects) ? data.objects : [];
  for (const obj of objects) {
    if (!obj) continue;
    const geo = makeShapeGeometry(obj);
    const mat = new THREE.MeshStandardMaterial({
      color: parseColor(obj.color, 0x886644),
      roughness: 0.75,
      metalness: 0.08,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const x = Number(obj.x) || 0;
    const y = Number(obj.y);
    const z = Number(obj.z) || 0;
    const h = Math.max(0.05, Number(obj.h) || 0.5);
    mesh.position.set(x, Number.isFinite(y) ? y : floorY + h * 0.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (obj.name) mesh.name = String(obj.name);
    group.add(mesh);
  }

  scene.add(group);

  const spawnRaw = data.spawn || {};
  const spawn = new THREE.Vector3(
    Number(spawnRaw.x) || (aabb.minX + aabb.maxX) * 0.5,
    Number(spawnRaw.y) || 1.6,
    Number(spawnRaw.z) != null
      ? Number(spawnRaw.z)
      : aabb.minZ * 0.2 + aabb.maxZ * 0.8
  );

  const lookRaw = data.lookAt || {};
  const lookTarget = photoLook
    ? photoLook.clone()
    : new THREE.Vector3(
        Number(lookRaw.x) || (aabb.minX + aabb.maxX) * 0.5,
        Number(lookRaw.y) || 1.4,
        Number(lookRaw.z) != null ? Number(lookRaw.z) : aabb.minZ
      );
  if (
    lookRaw &&
    (lookRaw.x != null || lookRaw.y != null || lookRaw.z != null)
  ) {
    lookTarget.set(
      Number(lookRaw.x) != null ? Number(lookRaw.x) : lookTarget.x,
      Number(lookRaw.y) != null ? Number(lookRaw.y) : lookTarget.y,
      Number(lookRaw.z) != null ? Number(lookRaw.z) : lookTarget.z
    );
  }

  const inset = 0.45;
  const bounds = {
    minX: aabb.minX + inset,
    maxX: aabb.maxX - inset,
    minZ: aabb.minZ + inset,
    maxZ: aabb.maxZ - inset,
  };
  spawn.x = THREE.MathUtils.clamp(spawn.x, bounds.minX, bounds.maxX);
  spawn.z = THREE.MathUtils.clamp(spawn.z, bounds.minZ, bounds.maxZ);

  return {
    group,
    spawn,
    lookTarget,
    bounds,
    title: data.title || 'Сцена Gemini',
    summary: data.summary || '',
  };
}
