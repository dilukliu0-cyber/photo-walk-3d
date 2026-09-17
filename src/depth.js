/**
 * In-browser depth estimation via Transformers.js (Depth Anything small).
 * Loaded via CDN ESM so Vite never touches onnxruntime-web (registerBackend
 * TypeError under Vite's node_modules serving).
 */

const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

let estimator = null;

/**
 * @param {(msg: string, pct: number) => void|Promise<void>} onProgress
 */
export async function loadDepthModel(onProgress) {
  if (estimator) return estimator;

  await onProgress?.('Скачиваю модель глубины…', 5);

  let pipeline;
  let env;
  try {
    // Prefer CDN so ort-web is not rewritten by Vite.
    const mod = await import(/* @vite-ignore */ TRANSFORMERS_CDN);
    pipeline = mod.pipeline;
    env = mod.env;
  } catch (cdnErr) {
    console.warn('CDN transformers failed, trying local package', cdnErr);
    try {
      const mod = await import(/* @vite-ignore */ '@xenova/transformers');
      pipeline = mod.pipeline;
      env = mod.env;
    } catch (err) {
      console.error(err);
      throw new Error(
        'Не удалось загрузить библиотеку глубины (сеть или совместимость). Проверьте интернет и обновите страницу.'
      );
    }
  }

  // Prefer WASM; avoid broken webgpu/ort backend registration under Vite.
  try {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
    }
  } catch (e) {
    console.warn('transformers env tweak failed', e);
  }

  try {
    estimator = await pipeline(
      'depth-estimation',
      'Xenova/depth-anything-small-hf',
      {
        progress_callback: (data) => {
          if (!data) return;
          if (data.status === 'progress' && data.total) {
            const pct = Math.min(90, Math.round((data.loaded / data.total) * 80) + 5);
            const name = data.file ? String(data.file).split('/').pop() : 'модель';
            void onProgress?.(`Загрузка: ${name}`, pct);
          } else if (data.status === 'initiate') {
            const name = data.file ? String(data.file).split('/').pop() : 'модель';
            void onProgress?.(`Скачиваю: ${name}`, 8);
          } else if (data.status === 'download') {
            void onProgress?.('Скачиваю файлы модели…', 10);
          } else if (data.status === 'ready' || data.status === 'done') {
            void onProgress?.('Модель готова', 92);
          }
        },
      }
    );
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || err);
    if (/fetch|network|Failed to fetch|ERR_|CORS|timeout/i.test(msg)) {
      throw new Error(
        'Не удалось скачать модель глубины (сеть). Проверьте интернет и попробуйте снова.'
      );
    }
    if (/format|decode|HEIC|unsupported|image/i.test(msg)) {
      throw new Error(
        'Неподдерживаемый формат изображения. Сохрани фото как JPG или PNG.'
      );
    }
    throw new Error(
      `Ошибка модели глубины: ${msg || 'неизвестная ошибка'}. Попробуйте другое фото или обновите страницу.`
    );
  }

  await onProgress?.('Модель готова', 94);
  return estimator;
}

/**
 * Run depth estimation on an HTMLImageElement / canvas / URL.
 * Returns { width, height, data: Float32Array } normalized 0..1 (near=1, far=0 for displace).
 * @param {HTMLImageElement|HTMLCanvasElement|string} input
 * @param {(msg: string, pct: number) => void|Promise<void>} onProgress
 */
async function toModelInput(input) {
  // Transformers.js CDN build rejects bare canvas objects; prefer data URL / Image.
  if (typeof input === 'string') return input;
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    return input;
  }
  if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
    return input.toDataURL('image/png');
  }
  if (input && typeof input === 'object' && typeof input.toDataURL === 'function') {
    return input.toDataURL('image/png');
  }
  return input;
}

export async function estimateDepth(input, onProgress) {
  const model = await loadDepthModel(onProgress);

  await onProgress?.('Считаю карту глубины…', 96);

  const modelInput = await toModelInput(input);

  let result;
  try {
    result = await model(modelInput);
  } catch (err) {
    console.error(err);
    throw new Error(
      'Не удалось оценить глубину. Попробуйте другое JPG/PNG фото.'
    );
  }

  const depth = result.depth ?? result;
  const w = depth.width;
  const h = depth.height;
  let raw = depth.data;

  let f32;
  if (raw instanceof Float32Array) {
    f32 = raw;
  } else if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) {
    f32 = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) f32[i] = raw[i] / 255;
  } else {
    f32 = new Float32Array(raw);
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const normalized = new Float32Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    normalized[i] = 1 - (f32[i] - min) / range;
  }

  await onProgress?.('Глубина готова', 98);
  return { width: w, height: h, data: normalized };
}
