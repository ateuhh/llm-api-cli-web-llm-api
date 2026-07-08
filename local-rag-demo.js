import { access } from "node:fs/promises";
import { DocumentIndexer } from "./document-indexer.js";
import { LocalRagAgent } from "./local-rag-agent.js";

let compareCloud = process.argv.includes("--compare-cloud");
const questions = [
  "Какая команда запускает MCP pipeline из search, summarize и save?",
  "Какие состояния есть у Task State Machine?",
  "Какие слои памяти есть у ассистента?",
  "Какой инвариант запрещает GraphQL?",
  "Как запустить локальный CLI-чат через Ollama?"
];

if (compareCloud && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --compare-cloud задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

async function ensureIndex(indexPath) {
  const shouldRebuild = process.env.LOCAL_RAG_REBUILD !== "false";

  if (shouldRebuild) {
    const indexer = new DocumentIndexer();
    await indexer.buildAndSaveAll();
    return true;
  }

  try {
    await access(indexPath);
    return false;
  } catch {
    const indexer = new DocumentIndexer();
    await indexer.buildAndSaveAll();
    return true;
  }
}

function printResult(label, result, agent) {
  console.log(`\n[${label}]`);
  console.log(`Модель: ${result.metrics.model}`);
  console.log(`Время: ${result.metrics.durationMs} мс`);
  console.log(`Токены: prompt=${result.metrics.promptTokens}, completion=${result.metrics.completionTokens}`);
  console.log("Источники retrieval:");
  console.log(agent.formatSources(result.chunks) || "релевантные чанки не найдены");
  console.log("\nОтвет:");
  console.log(result.answer);
}

function explainCloudError(error) {
  if (/сертификату НУЦ Минцифры|SELF_SIGNED_CERT_IN_CHAIN/i.test(error.message)) {
    return [
      "Облачное сравнение не выполнено: Node.js не доверяет сертификату НУЦ Минцифры.",
      "Запустите secure-команду:",
      "",
      "GIGACHAT_AUTH_KEY=\"ваш_ключ\" npm run local-rag:secure -- --compare-cloud",
      "",
      "Локальный RAG при этом работает без сертификата и облака: npm run local-rag"
    ].join("\n");
  }

  return `Облачное сравнение не выполнено: ${error.message}`;
}

const agent = new LocalRagAgent();
const indexWasBuilt = await ensureIndex(agent.indexPath);
await agent.loadIndex();
await agent.assertOllamaReady();

console.log("Local RAG demo запущен.");
console.log(`Индекс: ${agent.indexPath}${indexWasBuilt ? " (создан заново)" : ""}`);
console.log(`Чанков в индексе: ${agent.index.chunks.length}`);
console.log(`Retrieval: локальный hashing embedding + cosine similarity, topK=${agent.topK}`);
console.log(`Генерация: локальная Ollama модель ${agent.ollamaModel}`);
console.log(compareCloud ? "Сравнение с облачной моделью: включено" : "Сравнение с облачной моделью: выключено");

const summary = [];

for (const [index, question] of questions.entries()) {
  console.log(`\n=== Вопрос ${index + 1}: ${question} ===`);

  const local = await agent.askLocal(question);
  printResult("Локальный RAG", local, agent);

  const item = {
    question,
    localDurationMs: local.metrics.durationMs,
    localPromptTokens: local.metrics.promptTokens,
    localCompletionTokens: local.metrics.completionTokens,
    cloudDurationMs: null,
    cloudPromptTokens: null,
    cloudCompletionTokens: null
  };

  if (compareCloud) {
    try {
      const cloud = await agent.askCloud(question);
      printResult("Облачный RAG", cloud, agent);
      item.cloudDurationMs = cloud.metrics.durationMs;
      item.cloudPromptTokens = cloud.metrics.promptTokens;
      item.cloudCompletionTokens = cloud.metrics.completionTokens;
    } catch (error) {
      console.error(`\n[Облачный RAG]\n${explainCloudError(error)}`);
      item.cloudError = error.message;
      compareCloud = false;
    }
  }

  summary.push(item);
}

console.log("\n=== Итоговое сравнение ===");
for (const item of summary) {
  const local = `local ${item.localDurationMs} мс, tokens ${item.localPromptTokens}+${item.localCompletionTokens}`;
  const cloud = item.cloudDurationMs === null
    ? "cloud не запускался"
    : `cloud ${item.cloudDurationMs} мс, tokens ${item.cloudPromptTokens}+${item.cloudCompletionTokens}`;
  console.log(`- ${item.question}: ${local}; ${cloud}`);
}

console.log("\nВывод:");
console.log("- Retrieval полностью локальный: индекс JSON, embeddings и similarity считаются на машине.");
console.log("- Генерация полностью локальная: ответы идут через Ollama API на 127.0.0.1.");
console.log("- Маленькая локальная модель быстрее и бесплатна в запуске, но качество и стабильность обычно ниже, чем у сильной облачной модели.");
