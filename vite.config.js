import { defineConfig, loadEnv } from 'vite';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SCENE_PROMPT = `Ты — ИИ, который по фотографии придумывает проходимую 3D-сцену из примитивов.
Проанализируй фото и верни ТОЛЬКО валидный JSON (без markdown, без \`\`\`, без пояснений) по схеме:

{
  "title": "string",
  "sceneType": "indoor|outdoor|object|other",
  "summary": "короткое описание сцены на русском",
  "ground": { "y": 0, "size": 20, "color": "#888888" },
  "skyColor": "#87ceeb",
  "photoPlane": { "distance": 8, "width": 12, "height": 8 },
  "objects": [
    {
      "name": "chair",
      "x": 0, "y": 0.5, "z": -3,
      "w": 0.6, "h": 1, "d": 0.6,
      "color": "#886644",
      "shape": "box|cylinder|sphere"
    }
  ],
  "spawn": { "x": 0, "y": 1.6, "z": 4 },
  "bounds": { "minX": -8, "maxX": 8, "minZ": -10, "maxZ": 6 }
}

Правила:
- Придумай правдоподобную проходимую раскладку, вдохновлённую фото (пол, крупные объекты как примитивы).
- Фото будет большим вертикальным plane впереди (photoPlane.distance — Z отрицательный по смыслу: расстояние вперёд от игрока).
- 3–12 объектов; координаты в метрах; spawn.y ≈ 1.6 (глаза).
- ground.size 12–30; bounds должны позволять ходить перед фотоплоскостью.
- Цвета — hex строки.
- Только JSON.`;

function stripJsonFences(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Некорректный JSON в теле запроса'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

async function generateSceneWithGemini(apiKey, imageBase64, mimeType) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const models = [
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-2.5-flash',
    'gemini-flash-latest',
  ];
  let lastErr = null;
  let usedModel = models[0];

  const cleanB64 = String(imageBase64 || '').replace(/^data:[^;]+;base64,/, '');

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      });
      const result = await model.generateContent([
        { text: SCENE_PROMPT },
        {
          inlineData: {
            mimeType: mimeType || 'image/png',
            data: cleanB64,
          },
        },
      ]);
      const text = result?.response?.text?.() ?? '';
      const parsed = JSON.parse(stripJsonFences(text));
      usedModel = modelName;
      return { scene: parsed, model: usedModel };
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const status = err?.status || err?.statusCode;
      // Fallback on 404 / model not found
      if (
        status === 404 ||
        /not found|404|is not found|NOT_FOUND/i.test(msg)
      ) {
        continue;
      }
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
          const apiKey =
            env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

          if (!apiKey || !String(apiKey).trim()) {
            sendJson(res, 500, {
              error:
                'GEMINI_API_KEY не задан на сервере. Добавьте ключ в .env.local (без префикса VITE_).',
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

          if (!scene || typeof scene !== 'object') {
            sendJson(res, 502, {
              error: 'Gemini вернул пустой ответ. Попробуйте другое фото.',
            });
            return;
          }

          sendJson(res, 200, { scene, model });
        } catch (err) {
          console.error('[api/scene]', err);
          const msg = String(err?.message || err);
          let ru = `Ошибка Gemini: ${msg}`;
          if (/API[_ ]?key|invalid.?api.?key|PERMISSION_DENIED|\b403\b/i.test(msg)) {
            ru =
              'Неверный или отозванный GEMINI_API_KEY. Проверьте ключ в .env.local.';
          } else if (/\b429\b|quota.?exceeded|resource.?exhausted|rate.?limit/i.test(msg)) {
            ru = 'Лимит Gemini исчерпан. Подождите и попробуйте снова.';
          } else if (/\b404\b|is not found|NOT_FOUND/i.test(msg)) {
            ru =
              'Модель Gemini не найдена. Обновите сервер или проверьте доступные модели.';
          } else if (/Unexpected token|JSON|parse/i.test(msg)) {
            ru =
              'Gemini вернул невалидный JSON. Попробуйте другое фото.';
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
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 3000,
  },
  optimizeDeps: {
    exclude: ['@xenova/transformers', 'onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
});
