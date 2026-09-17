/**
 * In-browser depth estimation via Transformers.js (Depth Anything small).
 */
import { pipeline, env } from '@xenova/transformers';

// Prefer local cache; allow WASM/CDN model download.
env.allowLocalModels = false;
env.useBrowserCache = true;

let estimator = null;

/**
 * @param {(msg: string, pct: number) => void|Promise<void>} onProgress
 */
export async function loadDepthModel(onProgress) {
  if (estimator) return estimator;

  await onProgress?.('Скачиваю модель глубины…', 5);

  estimator = await pipeline(
    'depth-estimation',
    'Xenova/depth-anything-small-hf',
    {
      progress_callback: (data) => {
        if (!data) return;
        if (data.status === 'progress' && data.total) {
          const pct = Math.min(90, Math.round((data.loaded / data.total) * 80) + 5);
          const name = data.file ? String(data.file).split('/').pop() : 'модель';
          // Fire-and-forget so UI can paint between network chunks
          void onProgress?.(`Загрузка: ${name}`, pct);
        } else if (data.status === 'ready' || data.status === 'done') {
          void onProgress?.('Модель готова', 92);
        }
      },
    }
  );

  await onProgress?.('Модель готова', 94);
  return estimator;
}

/**
 * Run depth estimation on an HTMLImageElement / canvas / URL.
 * Returns { width, height, data: Float32Array } normalized 0..1 (near=1, far=0 for displace).
 * @param {HTMLImageElement|HTMLCanvasElement|string} input
 * @param {(msg: string, pct: number) => void|Promise<void>} onProgress
 */
export async function estimateDepth(input, onProgress) {
  const model = await loadDepthModel(onProgress);
  await onProgress?.('Считаю карту глубины…', 96);

  const result = await model(input);
  // result.depth is a RawImage (or similar) with data, width, height
  const depth = result.depth ?? result;
  const w = depth.width;
  const h = depth.height;
  let raw = depth.data;

  // Convert to Float32Array 0..1
  let f32;
  if (raw instanceof Float32Array) {
    f32 = raw;
  } else if (raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) {
    f32 = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) f32[i] = raw[i] / 255;
  } else {
    f32 = new Float32Array(raw);
  }

  // Normalize to 0..1
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
    // Depth Anything: larger = farther typically; invert so near surfaces pop forward
    normalized[i] = 1 - (f32[i] - min) / range;
  }

  await onProgress?.('Глубина готова', 98);
  return { width: w, height: h, data: normalized };
}
