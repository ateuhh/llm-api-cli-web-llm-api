import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const HOST = process.env.PRIVATE_AI_HOST || "127.0.0.1";
const PORT = Number(process.env.PRIVATE_AI_PORT || 8787);
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:1b";
const MAX_INPUT_CHARS = Number(process.env.PRIVATE_AI_MAX_INPUT_CHARS || 800);
const MAX_CONTEXT_MESSAGES = Number(process.env.PRIVATE_AI_MAX_CONTEXT_MESSAGES || 8);
const MAX_REQUEST_BYTES = Number(process.env.PRIVATE_AI_MAX_REQUEST_BYTES || 4096);
const REQUEST_TIMEOUT_MS = Number(process.env.PRIVATE_AI_TIMEOUT_MS || 20000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.PRIVATE_AI_RATE_WINDOW_MS || 60000);
const RATE_LIMIT_MAX = Number(process.env.PRIVATE_AI_RATE_LIMIT || 12);
const PUBLIC_DIR = join(process.cwd(), "private-ai-public");

const sessions = new Map();
const rateBuckets = new Map();
const stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  rejectedRequests: 0,
  completedRequests: 0
};

const toneInstructions = {
  soft: "Тон мягкий: поддержи тепло, без давления.",
  ironic: "Тон ироничный: добавь легкую самоиронию, но не обесценивай проблему.",
  hard: "Тон жестковатый: бодро и уверенно, но без унижения пользователя."
};

function jsonResponse(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function textResponse(response, status, text, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer"
  });
  response.end(text);
}

function clientKey(request) {
  return request.socket.remoteAddress || "unknown";
}

function checkRateLimit(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 0 };

  if (now > bucket.resetAt) {
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  return {
    allowed: bucket.count <= RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - bucket.count),
    resetInSeconds: Math.ceil((bucket.resetAt - now) / 1000)
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new Error(`Тело запроса больше лимита ${MAX_REQUEST_BYTES} байт.`);
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function validateChatInput(payload) {
  const message = String(payload.message || "").trim();
  const tone = ["soft", "ironic", "hard"].includes(payload.tone) ? payload.tone : "ironic";
  const sessionId = String(payload.sessionId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

  if (!message) {
    throw new Error("Введите описание ситуации.");
  }
  if (message.length > MAX_INPUT_CHARS) {
    throw new Error(`Слишком длинное сообщение. Лимит: ${MAX_INPUT_CHARS} символов.`);
  }

  return { message, tone, sessionId };
}

function getSession(sessionId) {
  const session = sessions.get(sessionId) || [];
  sessions.set(sessionId, session);
  return session;
}

function buildMessages({ message, tone, session }) {
  const recent = session.slice(-MAX_CONTEXT_MESSAGES);

  return [
    {
      role: "system",
      content: [
        "Ты сервис 'Братский мотиватор'.",
        "Пользователь описывает ситуацию, а ты отвечаешь мемной псевдофилософской поддержкой в духе российской интернет-культуры.",
        "Не утверждай, что это настоящая цитата Джейсона Стетхема.",
        "Не проси персональные данные, пароли, токены или файлы.",
        "Не давай опасных инструкций, медицинских, юридических или финансовых гарантий.",
        "Если пользователь просит навредить себе или другим, мягко поддержи и предложи обратиться за помощью.",
        "Ответ: 2-3 короткие фразы, только русский язык, без английских слов, без мата, без внешних ссылок.",
        "Формат: сначала обращение 'Брат,' или 'Слушай,', затем метафора строго по ситуации пользователя, затем короткий вывод.",
        "Не повторяй примеры из инструкции и не добавляй случайные сюжеты.",
        "Не повторяй одну и ту же фразу несколько раз.",
        "Не начинай с оценок вроде 'Плохо' или 'Это ужасно'.",
        toneInstructions[tone]
      ].join(" ")
    },
    ...recent,
    { role: "user", content: message }
  ];
}

function fallbackMotivation(message, tone) {
  const situation = message.length > 80 ? "этот день" : "эта ситуация";

  if (tone === "hard") {
    return `Брат, ${situation} не приговор, а проверка сцепления. Сжал зубы, выдохнул, сделал следующий шаг.`;
  }
  if (tone === "soft") {
    return `Слушай, ${situation} не делает тебя слабым. Иногда день давит, чтобы ты вспомнил: ты всё ещё стоишь.`;
  }

  return `Брат, ${situation} не сломала тебя, а просто проверила подвеску. Дорога к нормальному дню иногда начинается с кривого поворота.`;
}

function normalizeAnswer(answer, message, tone) {
  const cleaned = answer.replace(/\s+/g, " ").trim();

  if (!cleaned || cleaned.length < 40 || /[A-Za-z]{2,}/.test(cleaned)) {
    return fallbackMotivation(message, tone);
  }

  return cleaned;
}

async function callOllama(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: {
          temperature: 0.25,
          num_predict: 70,
          num_ctx: 2048
        },
        messages
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama API HTTP ${response.status}: ${text}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function handleChat(request, response) {
  stats.totalRequests += 1;
  const rate = checkRateLimit(clientKey(request));

  if (!rate.allowed) {
    stats.rejectedRequests += 1;
    jsonResponse(response, 429, {
      error: `Слишком много запросов. Повторите через ${rate.resetInSeconds} сек.`
    }, { "Retry-After": String(rate.resetInSeconds) });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const input = validateChatInput(payload);
    const session = getSession(input.sessionId);
    const messages = buildMessages({ ...input, session });
    const data = await callOllama(messages);
    const answer = normalizeAnswer(data.message?.content?.trim() || "", input.message, input.tone);

    if (!answer) {
      throw new Error("Локальная модель вернула пустой ответ.");
    }

    session.push({ role: "user", content: input.message });
    session.push({ role: "assistant", content: answer });
    sessions.set(input.sessionId, session.slice(-MAX_CONTEXT_MESSAGES));
    stats.completedRequests += 1;

    jsonResponse(response, 200, {
      answer,
      sessionId: input.sessionId,
      model: data.model || OLLAMA_MODEL,
      limits: {
        maxInputChars: MAX_INPUT_CHARS,
        maxContextMessages: MAX_CONTEXT_MESSAGES,
        rateLimitPerMinute: RATE_LIMIT_MAX
      },
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        durationMs: Math.round((data.total_duration || 0) / 1_000_000)
      }
    });
  } catch (error) {
    stats.rejectedRequests += 1;
    const status = /JSON|Введите|длинное|лимит/i.test(error.message) ? 400 : 502;
    jsonResponse(response, status, { error: error.message });
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    textResponse(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    };
    textResponse(response, 200, content, types[extname(filePath)] || "application/octet-stream");
  } catch {
    textResponse(response, 404, "Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    jsonResponse(response, 200, {
      ok: true,
      model: OLLAMA_MODEL,
      host: HOST,
      port: PORT,
      ollama: OLLAMA_BASE_URL,
      privateMode: HOST === "127.0.0.1" || HOST === "localhost"
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/stats") {
    jsonResponse(response, 200, {
      ...stats,
      activeSessions: sessions.size,
      limits: {
        maxInputChars: MAX_INPUT_CHARS,
        maxContextMessages: MAX_CONTEXT_MESSAGES,
        maxRequestBytes: MAX_REQUEST_BYTES,
        rateLimitPerMinute: RATE_LIMIT_MAX,
        timeoutMs: REQUEST_TIMEOUT_MS
      }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    await handleChat(request, response);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(request, response);
    return;
  }

  jsonResponse(response, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`Private AI service: http://${HOST}:${PORT}`);
  console.log(`Ollama: ${OLLAMA_BASE_URL}, model: ${OLLAMA_MODEL}`);
  console.log(`Network mode: ${HOST === "127.0.0.1" ? "local only" : "network visible"}`);
});
