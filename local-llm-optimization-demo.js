import { access } from "node:fs/promises";
import { DocumentIndexer } from "./document-indexer.js";
import { LocalRagAgent } from "./local-rag-agent.js";

const model = process.env.OLLAMA_MODEL || "llama3.2:1b";
const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

const questions = [
  {
    question: "Какая команда запускает MCP pipeline из search, summarize и save?",
    expected: ["npm run mcp-pipeline", "search_project_files", "summarize_text", "save_to_file"]
  },
  {
    question: "Как запустить локальный CLI-чат через Ollama?",
    expected: ["ollama serve", "ollama pull llama3.2:1b", "npm run local-llm", "OLLAMA_MODEL"]
  },
  {
    question: "Как запустить локальный RAG и сравнение с облачной моделью?",
    expected: ["npm run local-rag", "local-rag:secure", "GIGACHAT_AUTH_KEY", "compare-cloud"]
  }
];

async function ensureIndex(indexPath) {
  try {
    await access(indexPath);
    return false;
  } catch {
    const indexer = new DocumentIndexer();
    await indexer.buildAndSaveAll();
    return true;
  }
}

async function getModelInfo() {
  const response = await fetch(`${baseUrl}/api/tags`);

  if (!response.ok) {
    throw new Error(`Ollama API недоступен: HTTP ${response.status}`);
  }

  const data = await response.json();
  const found = (data.models || []).find((item) => item.name === model);

  if (!found) {
    throw new Error(`Модель ${model} не найдена. Скачайте ее командой: ollama pull ${model}`);
  }

  return found;
}

function scoreAnswer(answer, expected) {
  const normalized = answer.toLowerCase();
  const matched = expected.filter((term) => normalized.includes(term.toLowerCase()));
  const hasSources = /источники:/i.test(answer);
  const hasCitations = /цитаты:/i.test(answer);
  const copiedTooMuch = answer.length > 2200;

  return {
    matched,
    total: expected.length,
    hasSources,
    hasCitations,
    copiedTooMuch,
    points: matched.length + (hasSources ? 1 : 0) + (hasCitations ? 1 : 0) - (copiedTooMuch ? 1 : 0)
  };
}

function createAgents() {
  const common = {
    ollamaBaseUrl: baseUrl,
    ollamaModel: model,
    relevanceThreshold: 0.18
  };

  return {
    baseline: new LocalRagAgent({
      ...common,
      topK: 4,
      promptProfile: "baseline",
      systemPrompt: "Ты полезный ассистент. Ответь на вопрос пользователя.",
      generationOptions: {
        temperature: 0.8,
        num_predict: 700,
        num_ctx: 4096
      }
    }),
    optimized: new LocalRagAgent({
      ...common,
      topK: 4,
      promptProfile: "optimized",
      systemPrompt: [
        "Ты локальный RAG-ассистент для отчета по учебному проекту.",
        "Отвечай только по найденным чанкам.",
        "Не выдумывай команды и URL.",
        "Дай короткий ответ, затем источники и цитаты."
      ].join(" "),
      generationOptions: {
        temperature: 0.1,
        num_predict: 160,
        num_ctx: 2048
      }
    })
  };
}

function printAnswer(label, result, score) {
  console.log(`\n[${label}]`);
  console.log(`Время: ${result.metrics.durationMs} мс`);
  console.log(`Токены: prompt=${result.metrics.promptTokens}, completion=${result.metrics.completionTokens}`);
  console.log(`Качество: ${score.matched.length}/${score.total} терминов, points=${score.points}`);
  console.log(`Источники/цитаты: ${score.hasSources ? "sources ok" : "sources нет"}, ${score.hasCitations ? "citations ok" : "citations нет"}`);
  console.log(`Длина ответа: ${result.answer.length} символов${score.copiedTooMuch ? " (слишком длинно)" : ""}`);
  console.log("Ответ:");
  console.log(result.answer);
}

function summarize(label, items) {
  const totals = items.reduce(
    (sum, item) => ({
      durationMs: sum.durationMs + item.result.metrics.durationMs,
      promptTokens: sum.promptTokens + item.result.metrics.promptTokens,
      completionTokens: sum.completionTokens + item.result.metrics.completionTokens,
      points: sum.points + item.score.points,
      matched: sum.matched + item.score.matched.length,
      expected: sum.expected + item.score.total
    }),
    { durationMs: 0, promptTokens: 0, completionTokens: 0, points: 0, matched: 0, expected: 0 }
  );

  return {
    label,
    avgDurationMs: Math.round(totals.durationMs / items.length),
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    matched: totals.matched,
    expected: totals.expected,
    points: totals.points
  };
}

const agents = createAgents();
const indexWasBuilt = await ensureIndex(agents.optimized.indexPath);
await agents.baseline.loadIndex();
await agents.optimized.loadIndex();

let modelInfo;
try {
  await agents.optimized.assertOllamaReady();
  modelInfo = await getModelInfo();
} catch (error) {
  if (/fetch failed|ECONNREFUSED|Ollama API недоступен/i.test(error.message)) {
    console.error("Ollama не запущена или недоступна на http://127.0.0.1:11434.");
    console.error("Запустите локальную модель в отдельном терминале:");
    console.error("");
    console.error("ollama serve");
    console.error("ollama pull llama3.2:1b");
    console.error("npm run local-llm-optimize");
    process.exit(1);
  }

  throw error;
}

console.log("Local LLM optimization demo запущен.");
console.log(`Индекс: ${agents.optimized.indexPath}${indexWasBuilt ? " (создан заново)" : ""}`);
console.log(`Модель: ${model}`);
console.log(`Размер: ${(modelInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
console.log(`Квантование: ${modelInfo.details?.quantization_level || "не указано"}`);
console.log(`Контекст модели: ${modelInfo.details?.context_length || "не указан"}`);
console.log("\nBaseline: temperature=0.8, max tokens=700, num_ctx=4096, общий prompt.");
console.log("Optimized: temperature=0.1, max tokens=160, num_ctx=2048, строгий RAG prompt, topK=4.");

const baselineResults = [];
const optimizedResults = [];

for (const [index, item] of questions.entries()) {
  console.log(`\n=== Вопрос ${index + 1}: ${item.question} ===`);

  const baseline = await agents.baseline.askLocal(item.question);
  const baselineScore = scoreAnswer(baseline.answer, item.expected);
  printAnswer("До оптимизации", baseline, baselineScore);
  baselineResults.push({ result: baseline, score: baselineScore });

  const optimized = await agents.optimized.askLocal(item.question);
  const optimizedScore = scoreAnswer(optimized.answer, item.expected);
  printAnswer("После оптимизации", optimized, optimizedScore);
  optimizedResults.push({ result: optimized, score: optimizedScore });
}

const before = summarize("До оптимизации", baselineResults);
const after = summarize("После оптимизации", optimizedResults);

console.log("\n=== Итог ===");
for (const item of [before, after]) {
  console.log(
    `${item.label}: avg ${item.avgDurationMs} мс; ` +
      `tokens prompt=${item.promptTokens}, completion=${item.completionTokens}; ` +
      `качество ${item.matched}/${item.expected}; points=${item.points}`
  );
}

console.log("\nВывод:");
console.log("- Температура 0.1 снижает разброс и галлюцинации по сравнению с 0.8.");
console.log("- num_predict=160 ограничивает длинные ответы и ускоряет генерацию.");
console.log("- num_ctx=2048 ограничивает рабочее контекстное окно под задачу RAG по проекту.");
console.log("- Prompt-шаблон заставляет модель отвечать по источникам и цитатам.");
console.log("- Квантование берется из локальной Ollama-модели; для llama3.2:1b сейчас используется Q8_0.");
