import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CONTROL_QUESTIONS, RagAgent } from "./rag-agent.js";

const useRealApi = process.argv.includes("--real");
const skipConfirmation = process.argv.includes("--yes");
const questionArgIndex = process.argv.findIndex((arg) => arg === "--question");
const singleQuestion = questionArgIndex >= 0 ? process.argv[questionArgIndex + 1] : "";

if (useRealApi && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --real задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

if (useRealApi && !skipConfirmation) {
  console.log("Будет выполнено до 30 реальных запросов к GigaChat: без RAG, RAG baseline и улучшенный RAG для каждого вопроса.");
  console.log("Запросы расходуют API-квоту. Остановить выполнение можно через Ctrl+C.");
  const cli = createInterface({ input, output });
  const confirmation = await cli.question('Введите "ДА", чтобы продолжить: ');
  cli.close();

  if (confirmation.trim() !== "ДА") {
    console.log("Демонстрация отменена. Ни одного запроса к GigaChat не отправлено.");
    process.exit(0);
  }
}

const agent = new RagAgent({
  mock: !useRealApi,
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
});
await agent.buildIndex();

function findControlQuestion(question) {
  return CONTROL_QUESTIONS.find((item) => item.question === question) || {
    question,
    expected: [],
    sources: []
  };
}

function formatSources(chunks) {
  return chunks
    .map((chunk) => {
      const similarity = Number.isFinite(chunk.similarity)
        ? ` similarity=${chunk.similarity.toFixed(2)}`
        : "";
      const finalScore = Number.isFinite(chunk.finalScore)
        ? ` final=${chunk.finalScore.toFixed(2)}`
        : "";
      return `${chunk.source}:${chunk.lineStart} score=${chunk.score.toFixed(2)}${similarity}${finalScore}`;
    })
    .join("; ");
}

function formatRetrieval(retrieval) {
  if (!retrieval || retrieval.threshold === null) {
    return "Режим baseline: query rewrite и фильтр релевантности не применяются.";
  }

  return [
    `Query rewrite: ${retrieval.rewrittenQuery}`,
    `Top-K до фильтрации: ${retrieval.topKBefore}`,
    `Порог релевантности: ${retrieval.threshold}`,
    `Прошло фильтр: ${retrieval.filtered.length}`,
    `Top-K после фильтрации: ${retrieval.topKAfter}`
  ].join("\n");
}

async function runQuestion(controlQuestion, index = 1) {
  console.log(`\n=== Вопрос ${index}: ${controlQuestion.question} ===`);
  console.log(`Ожидание: ${controlQuestion.expected.join(", ") || "не задано"}`);
  console.log(`Ожидаемые источники: ${controlQuestion.sources.join(", ") || "не заданы"}`);

  const withoutRag = await agent.askWithoutRag(controlQuestion.question);
  const baselineRag = await agent.askWithRag(controlQuestion.question, {
    preferredSources: controlQuestion.sources,
    mode: "baseline"
  });
  const enhancedRag = await agent.askWithRag(controlQuestion.question, {
    preferredSources: controlQuestion.sources,
    mode: "enhanced"
  });
  const withoutScore = agent.scoreAnswer(withoutRag, controlQuestion.expected);
  const baselineScore = agent.scoreAnswer(baselineRag.answer, controlQuestion.expected);
  const enhancedScore = agent.scoreAnswer(enhancedRag.answer, controlQuestion.expected);

  console.log("\n[Без RAG]");
  console.log(withoutRag);
  console.log(`Качество: ${withoutScore.matched.length}/${withoutScore.total}`);

  console.log("\n[RAG baseline: без query rewrite и фильтра]");
  console.log(formatRetrieval(baselineRag.retrieval));
  console.log(`Найденные чанки: ${formatSources(baselineRag.chunks) || "нет"}`);
  console.log(baselineRag.answer);
  console.log(`Качество: ${baselineScore.matched.length}/${baselineScore.total}`);

  console.log("\n[Улучшенный RAG: rewrite + rerank/filter]");
  console.log(formatRetrieval(enhancedRag.retrieval));
  console.log(`Кандидаты до фильтрации: ${formatSources(enhancedRag.retrieval.candidates) || "нет"}`);
  console.log(`Выбранные чанки после фильтрации: ${formatSources(enhancedRag.chunks) || "нет"}`);
  console.log(enhancedRag.answer);
  console.log(`Качество: ${enhancedScore.matched.length}/${enhancedScore.total}`);

  return {
    withoutScore,
    baselineScore,
    enhancedScore
  };
}

if (singleQuestion) {
  await runQuestion(findControlQuestion(singleQuestion));
} else {
  const results = [];
  for (const [index, controlQuestion] of CONTROL_QUESTIONS.entries()) {
    results.push(await runQuestion(controlQuestion, index + 1));
  }

  const withoutTotal = results.reduce((sum, item) => sum + item.withoutScore.matched.length, 0);
  const baselineTotal = results.reduce((sum, item) => sum + item.baselineScore.matched.length, 0);
  const enhancedTotal = results.reduce((sum, item) => sum + item.enhancedScore.matched.length, 0);
  const maxTotal = results.reduce((sum, item) => sum + item.enhancedScore.total, 0);

  console.log("\n=== Итоговое сравнение ===");
  console.log(`Без RAG: ${withoutTotal}/${maxTotal}`);
  console.log(`RAG baseline: ${baselineTotal}/${maxTotal}`);
  console.log(`Улучшенный RAG: ${enhancedTotal}/${maxTotal}`);
  console.log(
    enhancedTotal >= baselineTotal
      ? "Query rewrite + rerank/filter дали не хуже или лучше качество, а список чанков стал контролируемым."
      : "Улучшенный RAG уступил baseline, нужно перенастроить порог или эвристику rerank."
  );
}
