import './style.css';
import * as THREE from 'three';
import { createFPSControls } from './controls.js';
import {
  fileToBase64Payload,
  fetchGeminiScene,
  buildGeminiScene,
  disposeSceneGroup,
} from './geminiScene.js';

// --- Global error banner (boot safety) ---
function ensureErrorBanner() {
  let el = document.getElementById('boot-error');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'boot-error';
  el.setAttribute('role', 'alert');
  el.style.cssText =
    'display:none;position:fixed;left:12px;right:12px;top:12px;z-index:99999;' +
    'background:#3a1218;border:1px solid #ff6b7a;color:#ffe4e8;padding:12px 14px;' +
    'border-radius:10px;font:600 14px/1.4 system-ui,sans-serif;white-space:pre-wrap;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.45);max-height:40vh;overflow:auto;';
  document.body.appendChild(el);
  return el;
}

function showBootError(msg) {
  const el = ensureErrorBanner();
  el.style.display = 'block';
  el.textContent = msg;
}

function hideBootError() {
  const el = document.getElementById('boot-error');
  if (el) el.style.display = 'none';
}

window.addEventListener('error', (ev) => {
  const m = ev?.error?.message || ev?.message || String(ev);
  showBootError(`Ошибка страницы: ${m}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev?.reason;
  const m = r?.message || String(r);
  showBootError(`Ошибка: ${m}`);
});

const canvas = document.getElementById('c');
const overlay = document.getElementById('overlay');
const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const hud = document.getElementById('hud');
const btnReset = document.getElementById('btn-reset');
const btnNew = document.getElementById('btn-new');
const hint = document.getElementById('hint');
const stepEls = [1, 2, 3, 4].map((n) => document.getElementById(`step-${n}`));

function showLoadingUI(text) {
  const msg = text || 'Обработка…';
  if (loadingOverlay) {
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.setAttribute('aria-hidden', 'false');
  }
  if (loadingText) loadingText.textContent = msg;
  if (progressWrap) progressWrap.classList.remove('hidden');
  if (progressLabel) {
    progressLabel.classList.remove('error');
    progressLabel.textContent = msg;
  }
  if (progressBar) progressBar.style.width = '2%';
  setStepState(1);
  if (progressWrap) void progressWrap.offsetHeight;
  if (loadingOverlay) void loadingOverlay.offsetHeight;
}

function hideLoadingOverlay() {
  if (loadingOverlay) {
    loadingOverlay.classList.add('hidden');
    loadingOverlay.setAttribute('aria-hidden', 'true');
  }
}

function yieldToUI() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function setBusy(busy) {
  uploadBtn?.classList.toggle('busy', busy);
  if (fileInput) fileInput.disabled = busy;
}

function setStepState(activeStep) {
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
  if (pct >= 100 || m.includes('готово')) return 5;
  if (
    m.includes('собираю') ||
    m.includes('3d') ||
    m.includes('строю') ||
    pct >= 85
  ) {
    return 4;
  }
  if (
    m.includes('строит сцен') ||
    m.includes('gemini строит') ||
    m.includes('анализ') ||
    (pct >= 35 && pct < 85)
  ) {
    return 3;
  }
  if (
    m.includes('отправляю') ||
    m.includes('gemini') ||
    m.includes('сервер') ||
    (pct >= 5 && pct < 35)
  ) {
    return 2;
  }
  return 1;
}

async function setProgress(msg, pct) {
  progressWrap?.classList.remove('hidden');
  if (progressLabel) {
    progressLabel.classList.remove('error');
    progressLabel.textContent = msg;
  }
  if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (loadingText) loadingText.textContent = msg;
  if (loadingOverlay) {
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.setAttribute('aria-hidden', 'false');
  }
  setStepState(stepFromProgress(msg, pct));
  await yieldToUI();
}

function resetProgressUI() {
  if (progressBar) progressBar.style.width = '0%';
  if (progressLabel) {
    progressLabel.classList.remove('error');
    progressLabel.textContent = 'Загрузка…';
  }
  if (loadingText) loadingText.textContent = 'Обработка…';
  setStepState(1);
}

function loadImageFromFile(file) {
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

// --- Renderer / scene ---
let renderer;
let scene;
let camera;
let fps;
let sceneGroup = null;
let spawnPos = new THREE.Vector3(0, 1.6, 3);
let lookTarget = new THREE.Vector3(0, 1.55, 0);
let bounds = {};
let playing = false;
let threeReady = false;

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050608);
  scene.fog = new THREE.FogExp2(0x050608, 0.012);

  camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.05,
    120
  );
  camera.position.set(0, 1.6, 3);

  const hemi = new THREE.HemisphereLight(0xdde6ff, 0x1a1510, 1.15);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.75);
  dir.position.set(2, 8, 4);
  scene.add(dir);
  const fill = new THREE.AmbientLight(0x404860, 0.4);
  scene.add(fill);

  fps = createFPSControls(camera, document.body);
  threeReady = true;

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
    if (playing && fps) fps.update(dt, bounds);
    if (renderer && scene && camera) renderer.render(scene, camera);
  }
  animate();
}

async function processPhoto(file) {
  setBusy(true);
  hideBootError();
  resetProgressUI();
  showLoadingUI('Отправляю фото в Gemini…');

  try {
    await setProgress('Отправляю фото в Gemini…', 10);

    const [image, payload] = await Promise.all([
      loadImageFromFile(file),
      fileToBase64Payload(file),
    ]);

    await setProgress('Gemini строит сцену…', 40);
    const { scene: sceneData, model } = await fetchGeminiScene(payload);
    console.info('[gemini] model:', model, 'title:', sceneData?.title);

    await setProgress('Собираю 3D…', 88);

    if (!threeReady) {
      throw new Error('3D-движок не инициализирован. Обновите страницу.');
    }

    disposeSceneGroup(scene, sceneGroup);
    sceneGroup = null;

    const built = buildGeminiScene(scene, sceneData, image);
    sceneGroup = built.group;
    spawnPos.copy(built.spawn);
    lookTarget.copy(built.lookTarget);
    bounds = built.bounds;
    fps.reset(spawnPos, lookTarget);

    playing = true;
    hideLoadingOverlay();
    overlay.classList.add('fade-out');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('fade-out');
    }, 450);
    hud.classList.remove('hidden');

    fps.enableTouchUI(true);

    const isCoarse =
      window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isCoarse) {
      hint.querySelector('.desktop-only')?.classList.remove('hidden');
      canvas.addEventListener('click', onCanvasClick);
    }

    const doneMsg = built.summary
      ? `Готово: ${built.title}`
      : 'Готово';
    await setProgress(doneMsg, 100);
    setStepState(5);
    hideLoadingOverlay();
  } catch (err) {
    console.error(err);
    const msg = `Ошибка: ${err?.message || err}`;
    hideLoadingOverlay();
    // Keep overlay visible so user can retry
    overlay?.classList.remove('hidden', 'fade-out');
    progressWrap?.classList.remove('hidden');
    if (progressLabel) {
      progressLabel.classList.add('error');
      progressLabel.textContent = msg;
    }
    if (progressBar) progressBar.style.width = '0%';
    setStepState(1);
    showBootError(msg);
  } finally {
    setBusy(false);
  }
}

function onCanvasClick() {
  if (playing && fps) fps.lock();
}

function setupListeners() {
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    showLoadingUI('Отправляю фото в Gemini…');
    void processPhoto(file);
    fileInput.value = '';
  });

  btnReset?.addEventListener('click', () => {
    if (!playing || !fps) return;
    fps.reset(spawnPos, lookTarget);
  });

  btnNew?.addEventListener('click', () => {
    playing = false;
    try {
      fps?.unlock();
      fps?.enableTouchUI(false);
    } catch (_) {
      /* ignore */
    }
    canvas?.removeEventListener('click', onCanvasClick);
    hud?.classList.add('hidden');
    overlay?.classList.remove('hidden');
    progressWrap?.classList.add('hidden');
    hideLoadingOverlay();
    hideBootError();
    if (progressBar) progressBar.style.width = '0%';
    if (progressLabel) progressLabel.classList.remove('error');
    setBusy(false);
    try {
      disposeSceneGroup(scene, sceneGroup);
      sceneGroup = null;
      if (scene) {
        scene.background = new THREE.Color(0x050608);
        scene.fog = new THREE.FogExp2(0x050608, 0.012);
      }
    } catch (_) {
      /* ignore */
    }
  });

  window.addEventListener('resize', () => {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

try {
  setupListeners();
} catch (err) {
  console.error(err);
  showBootError(`Не удалось привязать интерфейс: ${err?.message || err}`);
}

try {
  initThree();
} catch (err) {
  console.error(err);
  showBootError(
    `Ошибка 3D: ${err?.message || err}. Выбор фото всё ещё должен работать.`
  );
}
