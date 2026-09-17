import { defineConfig, loadEnv } from 'vite';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SCENE_PROMPT = `Проанализируй фото и верни ТОЛЬКО один JSON-объект (без markdown и пояснений) строго такой формы:
{
  "title": "краткий заголовок на русском",
  "sceneType": "indoor",
  "summary": "1-2 предложения на русском без кавычек внутри",
  "ground": { "y": 0, "size": 20, "color": "#6b7280" },
  "skyColor": "#87ceeb",
  "photoPlane": { "distance": 8, "width": 12, "height": 8 },
  "objects": [
    { "name": "object", "x": 1, "y": 0.5, "z": -3, "w": 0.6, "h": 1, "d": 0.6, "color": "#886644", "shape": "box" }
  ],
  "spawn": { "x": 0, "y": 1.6, "z": 4 },
  "bounds": { "minX": -8, "maxX": 8, "minZ": -10, "maxZ": 6 }
}
Правила: 3-10 объектов-примитивов (box|cylinder|sphere), метры, spawn.y=1.6, summary без двойных кавычек, только JSON.`;

function repairJsonText(text) {
  let t = String(text || '').trim();
  if (!t) throw new Error('empty Gemini text');
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  t = t.replace(/[\u201C\u201D\u00AB\u00BB]/g, '"').replace(/[\u2018\u2019]/g, "'");
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  t = t.replace(/,(\s*[}\]])/g, '$1');
  t = t.replace(/\/\/[^\n]*/g, '');
  return t.trim();
}

function tryParseScene(text) {
  const repaired = repairJsonText(text);
  try {
    return JSON.parse(repaired);
  } catch (e1) {
    let t = repaired;
    const openCurly = (t.match(/{/g) || []).length;
    const closeCurly = (t.match(/}/g) || []).length;
    const openSq = (t.match(/\[/g) || []).length;
    const closeSq = (t.match(/]/g) || []).length;
    const lastGood = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (lastGood > 10) {
      let cut = t.slice(0, lastGood + 1);
      cut = cut.replace(/,\s*$/, '');
      for (let i = 0; i < openSq - closeSq; i++) cut += ']';
      for (let i = 0; i < openCurly - closeCurly; i++) cut += '}';
      cut = cut.replace(/,(\s*[}\]])/g, '$1');
      try {
        return JSON.parse(cut);
      } catch (_) {}
    }
    throw e1;
  }
}

function normalizeScene(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const ground = s.ground || s.floor || {};
  const photoPlane = s.photoPlane || s.photo_plane || s.backdrop || {};
  const spawn = s.spawn || s.player || s.camera || {};
  const bounds = s.bounds || s.limits || {};
  const objects = Array.isArray(s.objects)
    ? s.objects
    : Array.isArray(s.items)
      ? s.items
      : [];

  const normObjs = objects.slice(0, 16).map((o, i) => {
    const obj = o || {};
    return {
      name: String(obj.name || obj.label || `obj${i + 1}`),
      x: Number(obj.x) || 0,
      y: Number(obj.y) || 0.5,
      z: Number(obj.z) || -2,
      w: Number(obj.w ?? obj.width) || 0.5,
      h: Number(obj.h ?? obj.height) || 0.5,
      d: Number(obj.d ?? obj.depth) || 0.5,
      color: typeof obj.color === 'string' ? obj.color : '#886644',
      shape: String(obj.shape || obj.type || 'box').toLowerCase(),
    };
  });

  return {
    title: String(s.title || s.name || 'Сцена Gemini'),
    sceneType: String(s.sceneType || s.type || 'other'),
    summary: String(s.summary || s.description || '').replace(/"/g, "'"),
    ground: {
      y: Number(ground.y) || 0,
      size: Number(ground.size || ground.scale) || 20,
      color: typeof ground.color === 'string' ? ground.color : '#6b7280',
    },
    skyColor:
      typeof s.skyColor === 'string'
        ? s.skyColor
        : typeof s.sky === 'string'
          ? s.sky
          : '#87ceeb',
    photoPlane: {
      distance: Number(photoPlane.distance || photoPlane.z) || 8,
      width: Number(photoPlane.width || photoPlane.w) || 12,
      height: Number(photoPlane.height || photoPlane.h) || 8,
    },
    objects: normObjs,
    spawn: {
      x: Number(spawn.x) || 0,
      y: Number(spawn.y) || 1.6,
      z: spawn.z != null ? Number(spawn.z) : 4,
    },
    bounds: {
      minX: bounds.minX != null ? Number(bounds.minX) : -8,
      maxX: bounds.maxX != null ? Number(bounds.maxX) : 8,
      minZ: bounds.minZ != null ? Number(bounds.minZ) : -10,
      maxZ: bounds.maxZ != null ? Number(bounds.maxZ) : 6,
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Некорректный JSON в теле запроса'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

async function callModel(model, parts) {
  const result = await model.generateContent(parts);
  const text = result?.response?.text?.() ?? '';
  return text;
}

async function generateSceneWithGemini(apiKey, imageBase64, mimeType) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-flash-latest',
    'gemini-1.5-flash',
  ];
  let lastErr = null;
  const cleanB64 = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');
  const imagePart = {
    inlineData: {
      mimeType: mimeType || 'image/jpeg',
      data: cleanB64,
    },
  };

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      });

      let text = await callModel(model, [{ text: SCENE_PROMPT }, imagePart]);
      let parsed;
      try {
        parsed = tryParseScene(text);
      } catch {
        const fixPrompt =
          'Исправь текст ниже в валидный JSON по схеме сцены (title, sceneType, summary, ground, skyColor, photoPlane, objects, spawn, bounds). Верни только JSON.\n\n' +
          String(text).slice(0, 12000);
        text = await callModel(model, [{ text: fixPrompt }]);
        parsed = tryParseScene(text);
      }

      return { scene: normalizeScene(parsed), model: modelName };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const status = err?.status || err?.statusCode;
      if (status === 404 || /not found|404|NOT_FOUND/i.test(msg)) continue;
      if (/JSON|parse|Unexpected token|empty Gemini/i.test(msg)) continue;
      throw err;
    }
  }
  throw lastErr || new Error('Gemini недоступен');
}

function geminiApiPlugin() {
  return {
    name: 'gemini-scene-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (url !== '/api/scene' || req.method !== 'POST') {
          next();
          return;
        }
        try {
          const mode = server.config.mode || 'development';
          const env = loadEnv(mode, process.cwd(), '');
          const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
          if (!apiKey.trim()) {
            sendJson(res, 500, {
              error:
                'GEMINI_API_KEY не задан на сервере. Добавьте ключ в .env.local.',
            });
            return;
          }
          const body = await readJsonBody(req);
          const { imageBase64, mimeType } = body || {};
          if (!imageBase64 || typeof imageBase64 !== 'string') {
            sendJson(res, 400, {
              error: 'Нужно поле imageBase64 (строка base64 изображения).',
            });
            return;
          }
          const { scene, model } = await generateSceneWithGemini(
            apiKey,
            imageBase64,
            mimeType || 'image/jpeg'
          );
          sendJson(res, 200, { scene, model });
        } catch (err) {
          console.error('[api/scene]', err);
          const msg = String(err?.message || err);
          let ru = `Ошибка Gemini: ${msg}`;
          if (/API[_ ]?key|invalid.?api.?key|PERMISSION_DENIED|\b403\b/i.test(msg)) {
            ru = 'Неверный или отозванный GEMINI_API_KEY. Проверьте ключ в .env.local.';
          } else if (/\b429\b|quota|rate.?limit|resource.?exhausted/i.test(msg)) {
            ru = 'Лимит Gemini исчерпан. Подождите и попробуйте снова.';
          } else if (/JSON|parse|Unexpected token|empty Gemini/i.test(msg)) {
            ru = 'Gemini вернул повреждённый ответ. Попробуйте другое фото или ещё раз.';
          }
          sendJson(res, 502, { error: ru });
        }
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [geminiApiPlugin()],
  server: { host: true, port: 5173 },
  build: { target: 'esnext', chunkSizeWarningLimit: 3000 },
  optimizeDeps: { exclude: ['@xenova/transformers', 'onnxruntime-web'] },
  worker: { format: 'es' },
});
