import './style.css';
import * as THREE from 'three';
import { estimateDepth } from './depth.js';
import { buildDepthMesh } from './mesh.js';
import { createFPSControls } from './controls.js';

const canvas = document.getElementById('c');
const overlay = document.getElementById('overlay');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const hud = document.getElementById('hud');
const btnReset = document.getElementById('btn-reset');
const btnNew = document.getElementById('btn-new');
const hint = document.getElementById('hint');
const stepEls = [1, 2, 3, 4].map((n) => document.getElementById(`step-${n}`));

// --- Renderer / scene ---
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050608);
scene.fog = new THREE.FogExp2(0x050608, 0.012);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.05,
  80
);
camera.position.set(0, 1.6, 3);

const hemi = new THREE.HemisphereLight(0xdde6ff, 0x1a1510, 1.15);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.55);
dir.position.set(2, 6, 4);
scene.add(dir);
const fill = new THREE.AmbientLight(0x404860, 0.35);
scene.add(fill);

const fps = createFPSControls(camera, document.body);

let photoMesh = null;
let spawnPos = new THREE.Vector3(0, 1.6, 3);
let lookTarget = new THREE.Vector3(0, 1.55, 0);
let bounds = {};
let playing = false;

/** Let the browser paint progress UI before heavy sync work. */
function yieldToUI() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function setBusy(busy) {
  uploadBtn?.classList.toggle('busy', busy);
  fileInput.disabled = busy;
}

function setStepState(activeStep) {
  // activeStep: 1..4 (current), or 5 = all done
  for (let i = 0; i < stepEls.length; i++) {
    const el = stepEls[i];
    if (!el) continue;
    const n = i + 1;
    el.classList.remove('pending', 'active', 'done');
    if (activeStep > n || activeStep >= 5) el.classList.add('done');
    else if (activeStep === n) el.classList.add('active');
    else el.classList.add('pending');
  }
}

function stepFromProgress(msg, pct) {
  const m = String(msg || '').toLowerCase();
  if (pct >= 100 || m.includes('готово') && m.includes('3d')) return 5;
  if (
    m.includes('меш') ||
    m.includes('3d') ||
    m.includes('построен') ||
    pct >= 99
  ) {
    return 4;
  }
  if (
    m.includes('глубин') ||
    m.includes('считаю') ||
    m.includes('оценк') ||
    (pct >= 95 && pct < 99)
  ) {
    return 3;
  }
  if (
    m.includes('модель') ||
    m.includes('скачива') ||
    m.includes('загрузка:') ||
    (pct >= 5 && pct < 95)
  ) {
    return 2;
  }
  return 1;
}

async function setProgress(msg, pct) {
  progressWrap.classList.remove('hidden');
  progressLabel.classList.remove('error');
  progressLabel.textContent = msg;
  progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  setStepState(stepFromProgress(msg, pct));
  await yieldToUI();
}

function resetProgressUI() {
  progressBar.style.width = '0%';
  progressLabel.classList.remove('error');
  progressLabel.textContent = 'Загрузка…';
  setStepState(1);
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** Downscale large photos for faster inference while keeping texture quality. */
function makeInferenceCanvas(img, maxSide = 512) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(64, Math.round(img.naturalWidth * scale));
  const h = Math.max(64, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function disposePhotoMesh() {
  if (!photoMesh) return;
  scene.remove(photoMesh);
  photoMesh.geometry.dispose();
  if (photoMesh.material.map) photoMesh.material.map.dispose();
  photoMesh.material.dispose();
  photoMesh = null;
}

async function processPhoto(file) {
  setBusy(true);
  resetProgressUI();
  progressWrap.classList.remove('hidden');
  await setProgress('Читаю фото…', 2);

  try {
    const image = await loadImageFromFile(file);

    // Full-res texture image stays in `image`; smaller canvas for depth model
    const inferCanvas = makeInferenceCanvas(image, 518);

    const depthMap = await estimateDepth(inferCanvas, setProgress);

    await setProgress('Строю 3D…', 99);

    disposePhotoMesh();

    photoMesh = buildDepthMesh(image, depthMap, {
      maxSize: 9,
      depthScale: 5.2,
      segments: 160,
    });
    scene.add(photoMesh);

    const { planeW, planeH, depthScale, spawn } = photoMesh.userData;
    spawnPos.copy(spawn);
    lookTarget.set(0, 1.55, -depthScale * 0.35);
    fps.reset(spawnPos, lookTarget);

    bounds = {
      minX: -planeW * 0.55,
      maxX: planeW * 0.55,
      minZ: -depthScale - 0.5,
      maxZ: depthScale * 0.35 + 2.5,
    };

    playing = true;
    overlay.classList.add('fade-out');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('fade-out');
    }, 450);
    hud.classList.remove('hidden');

    fps.enableTouchUI(true);

    // Desktop: click canvas to lock pointer
    const isCoarse =
      window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isCoarse) {
      hint.querySelector('.desktop-only')?.classList.remove('hidden');
      canvas.addEventListener('click', onCanvasClick);
    }

    await setProgress('Готово', 100);
    setStepState(5);
  } catch (err) {
    console.error(err);
    const msg = `Ошибка: ${err?.message || err}`;
    progressWrap.classList.remove('hidden');
    progressLabel.classList.add('error');
    progressLabel.textContent = msg;
    progressBar.style.width = '0%';
    setStepState(1);
    // Keep visible on card; alert is optional backup
  } finally {
    setBusy(false);
  }
}

function onCanvasClick() {
  if (playing) fps.lock();
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // Show feedback immediately (before async work)
  setBusy(true);
  progressWrap.classList.remove('hidden');
  progressLabel.classList.remove('error');
  progressLabel.textContent = 'Читаю фото…';
  progressBar.style.width = '2%';
  setStepState(1);
  processPhoto(file);
  fileInput.value = '';
});

btnReset.addEventListener('click', () => {
  if (!playing) return;
  fps.reset(spawnPos, lookTarget);
});

btnNew.addEventListener('click', () => {
  playing = false;
  fps.unlock();
  fps.enableTouchUI(false);
  canvas.removeEventListener('click', onCanvasClick);
  hud.classList.add('hidden');
  overlay.classList.remove('hidden');
  progressWrap.classList.add('hidden');
  progressBar.style.width = '0%';
  progressLabel.classList.remove('error');
  setBusy(false);
  disposePhotoMesh();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Hide hint after first lock
fps.controls.addEventListener('lock', () => {
  if (hint) hint.style.opacity = '0.35';
});
fps.controls.addEventListener('unlock', () => {
  if (hint) hint.style.opacity = '1';
});

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (playing) fps.update(dt, bounds);
  renderer.render(scene, camera);
}
animate();
