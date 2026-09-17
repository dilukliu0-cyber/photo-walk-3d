import { defineConfig, loadEnv } from 'vite';
import { GoogleGenerativeAI } from '@google/generative-ai';

const SCENE_PROMPT = `Ты — ИИ-архитектор. По фотографии сконструируй ПОЛНУЮ проходимую 3D-постройку (пол, стены, предметы), а не billboard.
Проанализируй фото и верни ТОЛЬКО валидный JSON (без markdown, без \`\`\`, без пояснений) строго по схеме:

{
  "title": "...",
  "sceneType": "indoor|outdoor",
  "summary": "...",
  "ceilingHeight": 2.8,
  "skyColor": "#87ceeb",
  "floor": { "y": 0, "color": "#666666", "polygon": [[-4,-4],[4,-4],[4,4],[-4,4]] },
  "walls": [{ "x1": -4, "z1": -4, "x2": 4, "z2": -4, "height": 2.8, "thickness": 0.15, "color": "#cccccc", "usePhoto": true }],
  "objects": [{ "name": "sofa", "x": 0, "y": 0.4, "z": -1, "w": 1.8, "h": 0.8, "d": 0.8, "color": "#554433", "shape": "box" }],
  "spawn": { "x": 0, "y": 1.6, "z": 2 },
  "lookAt": { "x": 0, "y": 1.4, "z": -4 }
}

Правила (обязательно):
- floor.polygon — ЗАМКНУтый многоугольник пола в плоскости XZ: 4–8 точек [x,z] в метрах, без самопересечений.
- walls — сегменты вдоль рёбер пола. Indoor: стены по ВСЕМ сторонам (замкнутый контур). Outdoor: частичные/низкие стены (height 0.4–1.5), не обязательно все стороны.
- Хотя бы 1 стена с "usePhoto": true — та, что смотрит на spawn (игрок видит фото на стене).
- objects: 4–12 пропов (мебель/деревья/машины как box|cylinder|sphere), координаты в метрах, внутри полигона.
- spawn ВНУТРИ полигона пола, spawn.y ≈ 1.6 (глаза). lookAt — точка на фото-стене или центре сцены.
- ceilingHeight в метрах (indoor ~2.5–3.2). Цвета — hex строки без кавычек внутри значений.
- title и summary на русском; БЕЗ вложенных кавычек " внутри строк (используй «» или апостроф).
- Единицы — метры. Только JSON, ничего кроме JSON.`;

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

/** Soft repairs for common Gemini JSON glitches. */
function repairJsonText(text) {
  let t = stripJsonFences(text);
  // trailing commas before } or ]
  t = t.replace(/,\s*([}\]])/g, '$1');
  // smart quotes → plain
  t = t.replace(/[\u201C\u201D\u00AB\u00BB]/g, '"');
  t = t.replace(/[\u2018\u2019]/g, "'");
  // unquoted hex-ish keys already ok; fix NaN/Infinity
  t = t.replace(/\bNaN\b/g, '0').replace(/\bInfinity\b/g, '0');
  return t;
}

function tryParseSceneJson(text) {
  const attempts = [stripJsonFences(text), repairJsonText(text)];
  let lastErr = null;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  // Last-ditch: remove control chars except whitespace
  try {
    const cleaned = repairJsonText(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    return JSON.parse(cleaned);
  } catch (err) {
    throw lastErr || err;
  }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function hexOr(v, fallback) {
  if (typeof v === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(v.trim())) {
    return v.startsWith('#') ? v.trim() : `#${v.trim()}`;
  }
  return fallback;
}

function polygonAABB(polygon) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const pt of polygon) {
    const x = num(pt?.[0], 0);
    const z = num(pt?.[1], 0);
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

function pointInPolygon(x, z, polygon) {
  // Ray casting
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = num(polygon[i][0], 0);
    const zi = num(polygon[i][1], 0);
    const xj = num(polygon[j][0], 0);
    const zj = num(polygon[j][1], 0);
    const intersect =
      zi > z !== zj > z &&
      x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function defaultRectangularRoom() {
  const half = 4;
  const h = 2.8;
  const polygon = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  // Far wall (negative Z) gets the photo — facing spawn at +Z
  const walls = [
    {
      x1: -half,
      z1: -half,
      x2: half,
      z2: -half,
      height: h,
      thickness: 0.15,
      color: '#c8c8c8',
      usePhoto: true,
    },
    {
      x1: half,
      z1: -half,
      x2: half,
      z2: half,
      height: h,
      thickness: 0.15,
      color: '#d0d0d0',
      usePhoto: false,
    },
    {
      x1: half,
      z1: half,
      x2: -half,
      z2: half,
      height: h,
      thickness: 0.15,
      color: '#bebebe',
      usePhoto: false,
    },
    {
      x1: -half,
      z1: half,
      x2: -half,
      z2: -half,
      height: h,
      thickness: 0.15,
      color: '#d0d0d0',
      usePhoto: false,
    },
  ];
  return {
    title: 'Комната по умолчанию',
    sceneType: 'indoor',
    summary: 'Прямоугольная комната с фото на дальней стене',
    ceilingHeight: h,
    skyColor: '#87ceeb',
    floor: { y: 0, color: '#666666', polygon },
    walls,
    objects: [
      {
        name: 'table',
        x: 0,
        y: 0.4,
        z: 0,
        w: 1.2,
        h: 0.75,
        d: 0.7,
        color: '#8b6914',
        shape: 'box',
      },
      {
        name: 'chair',
        x: -1.2,
        y: 0.45,
        z: 0.2,
        w: 0.5,
        h: 0.9,
        d: 0.5,
        color: '#705030',
        shape: 'box',
      },
      {
        name: 'plant',
        x: 2.5,
        y: 0.5,
        z: -2.5,
        w: 0.4,
        h: 1.0,
        d: 0.4,
        color: '#3a7a3a',
        shape: 'cylinder',
      },
      {
        name: 'lamp',
        x: 2.2,
        y: 0.7,
        z: 2.2,
        w: 0.35,
        h: 1.4,
        d: 0.35,
        color: '#e8e0c8',
        shape: 'cylinder',
      },
    ],
    spawn: { x: 0, y: 1.6, z: 2.2 },
    lookAt: { x: 0, y: 1.4, z: -half },
  };
}

/**
 * Fill missing walls/polygon with a default rectangular room so something always builds.
 * Normalize numbers, ensure spawn inside polygon, at least one usePhoto wall.
 */
export function normalizeScene(raw) {
  const fallback = defaultRectangularRoom();
  const data = raw && typeof raw === 'object' ? { ...raw } : {};

  const sceneType =
    data.sceneType === 'outdoor' || data.sceneType === 'indoor'
      ? data.sceneType
      : 'indoor';

  let floor = data.floor && typeof data.floor === 'object' ? { ...data.floor } : {};
  let polygon = Array.isArray(floor.polygon) ? floor.polygon.filter((p) => Array.isArray(p) && p.length >= 2) : [];
  if (polygon.length < 3) {
    polygon = fallback.floor.polygon.map((p) => [...p]);
    floor = {
      y: num(floor.y, 0),
      color: hexOr(floor.color, fallback.floor.color),
      polygon,
    };
  } else {
    // close polygon if first != last (keep open list of verts; builder closes)
    polygon = polygon.map((p) => [num(p[0], 0), num(p[1], 0)]);
    if (polygon.length > 8) polygon = polygon.slice(0, 8);
    floor = {
      y: num(floor.y, 0),
      color: hexOr(floor.color, '#666666'),
      polygon,
    };
  }

  let walls = Array.isArray(data.walls) ? data.walls.filter(Boolean) : [];
  if (walls.length === 0) {
    // Generate walls along polygon edges
    const h = num(data.ceilingHeight, fallback.ceilingHeight);
    const n = polygon.length;
    walls = [];
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      walls.push({
        x1: a[0],
        z1: a[1],
        x2: b[0],
        z2: b[1],
        height: sceneType === 'outdoor' ? Math.min(1.2, h * 0.4) : h,
        thickness: 0.15,
        color: '#cccccc',
        usePhoto: false,
      });
    }
    // Mark far wall (most negative mid-Z) as photo
    let best = 0;
    let bestZ = Infinity;
    walls.forEach((w, i) => {
      const midZ = (w.z1 + w.z2) * 0.5;
      if (midZ < bestZ) {
        bestZ = midZ;
        best = i;
      }
    });
    if (walls[best]) walls[best].usePhoto = true;
  } else {
    walls = walls.map((w) => ({
      x1: num(w.x1, 0),
      z1: num(w.z1, 0),
      x2: num(w.x2, 0),
      z2: num(w.z2, 0),
      height: Math.max(0.2, num(w.height, num(data.ceilingHeight, 2.8))),
      thickness: Math.max(0.05, num(w.thickness, 0.15)),
      color: hexOr(w.color, '#cccccc'),
      usePhoto: Boolean(w.usePhoto),
    }));
  }

  if (!walls.some((w) => w.usePhoto) && walls.length > 0) {
    let best = 0;
    let bestZ = Infinity;
    walls.forEach((w, i) => {
      const midZ = (w.z1 + w.z2) * 0.5;
      if (midZ < bestZ) {
        bestZ = midZ;
        best = i;
      }
    });
    walls[best].usePhoto = true;
  }

  let objects = Array.isArray(data.objects) ? data.objects.filter(Boolean) : [];
  if (objects.length === 0) {
    objects = fallback.objects.map((o) => ({ ...o }));
  } else {
    objects = objects.slice(0, 12).map((o) => ({
      name: String(o.name || 'prop'),
      x: num(o.x, 0),
      y: num(o.y, 0.4),
      z: num(o.z, 0),
      w: Math.max(0.05, num(o.w, 0.5)),
      h: Math.max(0.05, num(o.h, 0.5)),
      d: Math.max(0.05, num(o.d, 0.5)),
      color: hexOr(o.color, '#886644'),
      shape: ['box', 'cylinder', 'sphere'].includes(String(o.shape || '').toLowerCase())
        ? String(o.shape).toLowerCase()
        : 'box',
    }));
  }

  const aabb = polygonAABB(polygon);
  let spawn = data.spawn && typeof data.spawn === 'object' ? { ...data.spawn } : {};
  let sx = num(spawn.x, (aabb.minX + aabb.maxX) * 0.5);
  let sz = num(spawn.z, aabb.minZ * 0.25 + aabb.maxZ * 0.75);
  let sy = num(spawn.y, 1.6);
  if (!pointInPolygon(sx, sz, polygon)) {
    sx = (aabb.minX + aabb.maxX) * 0.5;
    sz = (aabb.minZ + aabb.maxZ) * 0.5;
  }
  spawn = { x: sx, y: sy, z: sz };

  let lookAt = data.lookAt && typeof data.lookAt === 'object' ? { ...data.lookAt } : {};
  const photoWall = walls.find((w) => w.usePhoto) || walls[0];
  if (photoWall) {
    lookAt = {
      x: num(lookAt.x, (photoWall.x1 + photoWall.x2) * 0.5),
      y: num(lookAt.y, Math.min(photoWall.height * 0.5, 1.5)),
      z: num(lookAt.z, (photoWall.z1 + photoWall.z2) * 0.5),
    };
  } else {
    lookAt = {
      x: num(lookAt.x, 0),
      y: num(lookAt.y, 1.4),
      z: num(lookAt.z, aabb.minZ),
    };
  }

  const title =
    typeof data.title === 'string' && data.title.trim()
      ? data.title.replace(/"/g, '«').slice(0, 80)
      : fallback.title;
  const summary =
    typeof data.summary === 'string' && data.summary.trim()
      ? data.summary.replace(/"/g, '«').slice(0, 240)
      : fallback.summary;

  return {
    title,
    sceneType,
    summary,
    ceilingHeight: Math.max(1.5, num(data.ceilingHeight, fallback.ceilingHeight)),
    skyColor: hexOr(data.skyColor, '#87ceeb'),
    floor,
    walls,
    objects,
    spawn,
    lookAt,
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
    let parseRetries = 0;
    while (parseRetries < 2) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: parseRetries === 0 ? 0.55 : 0.2,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          },
        });
        const promptExtra =
          parseRetries > 0
            ? '\n\nПОВТОР: предыдущий ответ был невалидным JSON. Верни ТОЛЬКО один JSON-объект по схеме, без markdown.'
            : '';
        const result = await model.generateContent([
          { text: SCENE_PROMPT + promptExtra },
          {
            inlineData: {
              mimeType: mimeType || 'image/png',
              data: cleanB64,
            },
          },
        ]);
        const text = result?.response?.text?.() ?? '';
        const parsed = tryParseSceneJson(text);
        const scene = normalizeScene(parsed);
        usedModel = modelName;
        return { scene, model: usedModel };
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        const status = err?.status || err?.statusCode;
        if (
          status === 404 ||
          /not found|404|is not found|NOT_FOUND/i.test(msg)
        ) {
          break; // try next model
        }
        if (/JSON|parse|Unexpected token|SyntaxError/i.test(msg) && parseRetries < 1) {
          parseRetries += 1;
          continue;
        }
        throw err;
      }
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

          // Guaranteed walls + floor polygon after normalize
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
