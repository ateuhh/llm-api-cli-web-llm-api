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
  console.log("Будет выполнено до 20 реальных запросов к GigaChat: без RAG и с RAG для каждого вопроса.");
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
    .map((chunk) => `${chunk.source}:${chunk.lineStart} score=${chunk.score.toFixed(2)}`)
    .join("; ");
}

async function runQuestion(controlQuestion, index = 1) {
  console.log(`\n=== Вопрос ${index}: ${controlQuestion.question} ===`);
  console.log(`Ожидание: ${controlQuestion.expected.join(", ") || "не задано"}`);
  console.log(`Ожидаемые источники: ${controlQuestion.sources.join(", ") || "не заданы"}`);

  const withoutRag = await agent.askWithoutRag(controlQuestion.question);
  const withRag = await agent.askWithRag(controlQuestion.question, {
    preferredSources: controlQuestion.sources
  });
  const withoutScore = agent.scoreAnswer(withoutRag, controlQuestion.expected);
  const withScore = agent.scoreAnswer(withRag.answer, controlQuestion.expected);

  console.log("\n[Без RAG]");
  console.log(withoutRag);
  console.log(`Качество: ${withoutScore.matched.length}/${withoutScore.total}`);

  console.log("\n[С RAG]");
  console.log(`Найденные чанки: ${formatSources(withRag.chunks) || "нет"}`);
  console.log(withRag.answer);
  console.log(`Качество: ${withScore.matched.length}/${withScore.total}`);

  return {
    withoutScore,
    withScore
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
  const withTotal = results.reduce((sum, item) => sum + item.withScore.matched.length, 0);
  const maxTotal = results.reduce((sum, item) => sum + item.withScore.total, 0);

  console.log("\n=== Итоговое сравнение ===");
  console.log(`Без RAG: ${withoutTotal}/${maxTotal}`);
  console.log(`С RAG: ${withTotal}/${maxTotal}`);
  console.log(
    withTotal >= withoutTotal
      ? "RAG дал более полный ответ по базе проекта."
      : "RAG не улучшил результат, нужно проверить чанки и контрольные ожидания."
  );
}
