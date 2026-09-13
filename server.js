// =================================================================
// MAX AI BACKEND — Railway прокси к Gemini Interactions API
// =================================================================
// Задача: приложение "Дежурный Макс" больше НЕ хранит ключ Gemini
// (и в будущем — Maps/Geocoding) внутри APK. Оно шлёт запрос сюда,
// сюда же переехал системный промпт (maxPrompt.js) — единый источник
// правды, правится без релиза приложения.
//
// Два режима одной и той же логики:
//   mode = "voice"   — голосовой Макс главного экрана (без стрима)
//   mode = "advisor" — советник маршрута (стрим, тот же system prompt отдельный)
// =================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { MAX_SYSTEM_PROMPT, MAX_ROUTE_ADVISOR_PROMPT } = require('./maxPrompt');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // фото в base64 бывают тяжёлые

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY не задан в переменных окружения. Останов.');
  process.exit(1);
}

// -----------------------------------------------------------------
// Firebase Admin — верифицирует подписанные Google ID-токены.
// На Railway нет metadata-сервера GCP, поэтому Application Default
// Credentials не подхватятся сами — нужен сервис-аккаунт явно.
// Секрет сервис-аккаунта живёт ТОЛЬКО в Variables на Railway (base64,
// чтобы не бороться с переносами строк в приватном ключе через UI),
// не в коде и не в git. Сама верификация токена всё равно идёт по
// публичным ключам Google — сервис-аккаунт нужен только для инициализации SDK.
// -----------------------------------------------------------------
const saB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!saB64) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_BASE64 не задан. Останов.');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(Buffer.from(saB64, 'base64').toString('utf8'));
} catch (e) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_BASE64 не парсится в JSON:', e.message);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// -----------------------------------------------------------------
// Защита: приложение обязано слать Firebase ID-токен в заголовке
// Authorization: Bearer <token>. Токен получают анонимным входом
// через firebase_auth на клиенте — живёт час, подписан Google,
// нечего извлекать статическим анализом APK.
// req.uid доступен во всех хендлерах после этого middleware —
// используется для rate-limit и для бана конкретного тестера.
// -----------------------------------------------------------------
async function checkFirebaseAuth(req, res, next) {
  const authHeader = req.header('Authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    console.warn('🔒 Отклонён невалидный токен:', e.message);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Лимит по uid, не по IP — водитель едет через страны, IP скачет
// каждые пару часов, а uid стабилен. 30 запросов в минуту на юзера.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.uid || req.ip, // до auth-миддлвары uid ещё нет — fallback на ip
});
app.use('/api/', limiter);

app.get('/health', (req, res) => res.json({ ok: true, model: GEMINI_MODEL }));

// -----------------------------------------------------------------
// Собираем "input" для Interactions API.
// history — чистый диалог без телеметрии: [{role:'user'|'model', text:'...'}]
// (совпадает с тем, что сейчас лежит в AiService._chatHistory, только
// без системного сообщения — оно теперь всегда system_instruction).
// -----------------------------------------------------------------
function buildInput(history, userText, imageBase64, imageMimeType) {
  const input = [];
  for (const turn of history || []) {
    const role = turn.role === 'assistant' || turn.role === 'model' ? 'model' : 'user';
    input.push({ role, content: [{ type: 'text', text: turn.text }] });
  }
  const userContent = [{ type: 'text', text: userText }];
  if (imageBase64) {
    userContent.push({
      type: 'image',
      data: imageBase64,
      mime_type: imageMimeType || 'image/jpeg',
    });
  }
  input.push({ role: 'user', content: userContent });
  return input;
}

// Достаёт из нового (steps) ответа Gemini весь текст модели одной строкой.
function extractText(json) {
  const steps = json.steps || json.outputs || [];
  let text = '';
  for (const step of steps) {
    const content = step.content || (step.type === 'text' ? [step] : []);
    for (const part of content) {
      if (part.type === 'text' && part.text) text += part.text;
    }
  }
  return text;
}

// =================================================================
// 1) НЕ-СТРИМ — голосовой Макс (и вообще любой разовый запрос)
// =================================================================
app.post('/api/max/chat', checkFirebaseAuth, async (req, res) => {
  try {
    const { message, history, imageBase64, imageMimeType, mode } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message (string) required' });
    }

    // 📊 Задел под будущую детекцию аномалий: пока просто лог,
    // позже можно писать в Firestore/файл и считать пороги по uid.
    console.log(`[usage] uid=${req.uid} mode=${mode || 'voice'} len=${message.length} img=${!!imageBase64}`);

    const systemPrompt = mode === 'advisor' ? MAX_ROUTE_ADVISOR_PROMPT : MAX_SYSTEM_PROMPT;

    const body = {
      model: GEMINI_MODEL,
      system_instruction: systemPrompt,
      input: buildInput(history, message, imageBase64, imageMimeType),
      generation_config: {
        temperature: 0.85,
        max_output_tokens: 1500,
      },
    };

    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
        'Api-Revision': '2026-05-20',
      },
      body: JSON.stringify(body),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini error:', geminiRes.status, errText);
      return res.status(502).json({ error: 'gemini_error', status: geminiRes.status, detail: errText });
    }

    const json = await geminiRes.json();
    const text = extractText(json);
    return res.json({ reply: text });
  } catch (e) {
    console.error('🧠 /api/max/chat error:', e);
    return res.status(500).json({ error: 'internal_error', detail: String(e) });
  }
});

// =================================================================
// 2) СТРИМ (SSE) — советник маршрута, "живой" ответ токен за токеном
//    Наружу отдаём простой протокол:
//      data: {"text":"кусочек ответа"}\n\n   — повторяется
//      data: [DONE]\n\n                       — конец
//      data: {"error":"..."}\n\n              — если что-то упало
// =================================================================
app.post('/api/max/chat/stream', checkFirebaseAuth, async (req, res) => {
  const { message, history, imageBase64, imageMimeType, mode } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message (string) required' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const systemPrompt = mode === 'voice' ? MAX_SYSTEM_PROMPT : MAX_ROUTE_ADVISOR_PROMPT;

  const body = {
    model: GEMINI_MODEL,
    system_instruction: systemPrompt,
    input: buildInput(history, message, imageBase64, imageMimeType),
    generation_config: {
      temperature: 0.85,
      max_output_tokens: 1024,
    },
    stream: true,
  };

  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
        'Api-Revision': '2026-05-20',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!geminiRes.ok || !geminiRes.body) {
      const errText = await geminiRes.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ error: `gemini_${geminiRes.status}: ${errText}` })}\n\n`);
      return res.end();
    }

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE-кадры разделены пустой строкой
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || ''; // последний кусок может быть неполным

      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw) continue;

        let evt;
        try {
          evt = JSON.parse(raw);
        } catch {
          continue;
        }

        if (evt.event_type === 'step.delta' && evt.delta && evt.delta.type === 'text') {
          res.write(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`);
        } else if (evt.event_type === 'interaction.completed') {
          res.write('data: [DONE]\n\n');
        }
      }
    }

    res.end();
  } catch (e) {
    console.error('🧠 /api/max/chat/stream error:', e);
    try {
      res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
    } catch {}
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`🚛 Max AI backend слушает порт ${PORT} | модель: ${GEMINI_MODEL}`);
});
