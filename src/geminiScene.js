import * as THREE from 'three';

/**
 * Downscale large photos so Gemini JSON is less likely to truncate.
 */
export async function resizeImageFile(file, maxSide = 1280, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось сжать фото'))),
      'image/jpeg',
      quality
    );
  });
  const name = String(file.name || 'photo').replace(/\.[^.]+$/, '.jpg');
  return new File([blob], name, { type: 'image/jpeg' });
}

/**
 * Read a File as raw base64 (no data: prefix) + mimeType.
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

/** Resize then encode for /api/scene */
export async function preparePhotoPayload(file) {
  const resized = await resizeImageFile(file);
  return fileToBase64Payload(resized);
}

/**
 * POST photo to Vite middleware /api/scene
 */
export async function fetchGeminiScene(payload) {
  const res = await fetch('/api/scene', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
 * Build walkable Three.js content from Gemini scene JSON + photo texture.
 */
export function buildGeminiScene(scene, sceneData, image) {
  const data = sceneData || {};
  const group = new THREE.Group();
  group.name = 'gemini-scene';

  const sky = parseColor(data.skyColor || data.sky, 0x87ceeb);
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.FogExp2(sky, 0.008);

  const groundSpec = data.ground || data.floor || {};
  const groundSize = Number(groundSpec.size) || 20;
  const groundY = Number(groundSpec.y) || 0;
  const groundMat = new THREE.MeshStandardMaterial({
    color: parseColor(groundSpec.color, 0x888888),
    roughness: 0.92,
    metalness: 0.05,
  });
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    groundMat
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundY;
  ground.receiveShadow = true;
  group.add(ground);

  const grid = new THREE.GridHelper(
    groundSize,
    Math.min(40, Math.round(groundSize)),
    0xffffff,
    0x444444
  );
  grid.position.y = groundY + 0.01;
  grid.material.opacity = 0.25;
  grid.material.transparent = true;
  group.add(grid);

  const pp = data.photoPlane || data.photo_plane || {};
  const distance = Math.max(2, Number(pp.distance) || 8);
  let planeW = Number(pp.width) || 12;
  let planeH = Number(pp.height) || 8;
  const imgW = image.naturalWidth || image.width || 1;
  const imgH = image.naturalHeight || image.height || 1;
  const aspect = imgW / imgH;
  if (aspect >= 1) planeH = planeW / aspect;
  else planeW = planeH * aspect;

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.anisotropy = 8;

  const photoMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, planeH),
    new THREE.MeshStandardMaterial({
      map: texture,
      side: THREE.DoubleSide,
      roughness: 0.85,
      metalness: 0,
    })
  );
  photoMesh.position.set(0, groundY + planeH * 0.5, -distance);
  group.add(photoMesh);

  const board = new THREE.Mesh(
    new THREE.BoxGeometry(planeW + 0.2, planeH + 0.2, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7 })
  );
  board.position.set(0, photoMesh.position.y, -distance - 0.06);
  group.add(board);

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
    mesh.position.set(x, Number.isFinite(y) ? y : groundY + h * 0.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (obj.name) mesh.name = String(obj.name);
    group.add(mesh);
  }

  scene.add(group);

  const spawnRaw = data.spawn || {};
  const spawn = new THREE.Vector3(
    Number(spawnRaw.x) || 0,
    Number(spawnRaw.y) || 1.6,
    Number(spawnRaw.z) != null ? Number(spawnRaw.z) : 4
  );

  const lookTarget = new THREE.Vector3(0, photoMesh.position.y, photoMesh.position.z);

  const b = data.bounds || {};
  const bounds = {
    minX: Number.isFinite(Number(b.minX)) ? Number(b.minX) : -groundSize * 0.4,
    maxX: Number.isFinite(Number(b.maxX)) ? Number(b.maxX) : groundSize * 0.4,
    minZ: Number.isFinite(Number(b.minZ)) ? Number(b.minZ) : -distance - 1,
    maxZ: Number.isFinite(Number(b.maxZ)) ? Number(b.maxZ) : spawn.z + 2,
  };

  return {
    group,
    spawn,
    lookTarget,
    bounds,
    title: data.title || 'Сцена Gemini',
    summary: data.summary || '',
  };
}
