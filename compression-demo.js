import { GigaChatAgent } from "./agent.js";

const useRealApi = process.argv.includes("--real");
const facts = ["Atlas", "Маяк", "PostgreSQL"];
const dialogue = [
  "Проект называется Atlas. Кодовое слово проекта: Маяк. База данных: PostgreSQL. Запомни эти факты.",
  "Мы делаем внутренний сервис управления задачами.",
  "В системе будут роли администратора и обычного пользователя.",
  "Задачи имеют сроки, статусы и исполнителей.",
  "Комментарии должны хранить автора и время создания.",
  "Нужен поиск по названию и описанию задачи.",
  "Уведомления отправляются при изменении статуса.",
  "История изменений должна быть доступна администраторам.",
  "Для API используем JSON и HTTP.",
  "Нужно предусмотреть постраничную выдачу.",
  "Добавим фильтрацию по статусу и исполнителю.",
  "Подготовься ответить на вопрос о фактах из начала разговора."
];
const finalQuestion = "Как называется проект, какое у него кодовое слово и какая используется база данных?";

function createAgent(compressionEnabled) {
  return new GigaChatAgent({
    authKey: process.env.GIGACHAT_AUTH_KEY,
    model: process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
    mock: !useRealApi,
    historyPath: `/tmp/gigachat-compression-${crypto.randomUUID()}.json`,
    compressionEnabled,
    recentMessageLimit: 6,
    summaryBatchSize: 6,
    contextWindow: 10000,
    maxCompletionTokens: 100
  });
}

if (useRealApi && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --real задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

function qualityScore(answer) {
  return facts.filter((fact) => answer.toLowerCase().includes(fact.toLowerCase())).length;
}

async function runDialogue(compressionEnabled) {
  const agent = createAgent(compressionEnabled);
  await agent.loadHistory();

  for (const message of dialogue) {
    await agent.chat(message);
  }

  const answer = await agent.chat(finalQuestion);
  return {
    answer,
    quality: qualityScore(answer),
    contextTokens: agent.lastMetrics.historyTokens,
    billedTokens: agent.usageTotals.billedTokens,
    cost: agent.usageTotals.estimatedCostRub,
    summary: agent.summary,
    recentMessages: agent.history.length - 1,
    compressionStats: agent.compressionStats
  };
}

const withoutCompression = await runDialogue(false);
const withCompression = await runDialogue(true);
const savedContextTokens = withoutCompression.contextTokens - withCompression.contextTokens;
const savedPercent = (savedContextTokens / withoutCompression.contextTokens) * 100;

console.log(`Режим: ${useRealApi ? "реальный GigaChat API" : "mock"}`);
console.log("=== Без сжатия ===");
console.log(`Ответ: ${withoutCompression.answer}`);
console.log(`Качество: ${withoutCompression.quality}/3 факта`);
console.log(`Токены контекста финального запроса: ${withoutCompression.contextTokens}`);
console.log(`Накопленные тарифицируемые токены: ${withoutCompression.billedTokens}`);
console.log(`Оценочная стоимость: ${withoutCompression.cost.toFixed(6)} ₽`);

console.log("\n=== Со сжатием ===");
console.log(`Ответ: ${withCompression.answer}`);
console.log(`Качество: ${withCompression.quality}/3 факта`);
console.log(`Токены контекста финального запроса: ${withCompression.contextTokens}`);
console.log(`Накопленные тарифицируемые токены: ${withCompression.billedTokens}`);
console.log(`Оценочная стоимость: ${withCompression.cost.toFixed(6)} ₽`);
console.log(`Последних сообщений без изменений: ${withCompression.recentMessages}`);
console.log(`Запусков компрессии: ${withCompression.compressionStats.runs}`);
console.log(`Summary: ${withCompression.summary}`);

console.log("\n=== Вывод ===");
console.log(
  `Контекст финального запроса уменьшился на ${savedContextTokens} токенов (${savedPercent.toFixed(1)}%).`
);
console.log(
  withCompression.quality === withoutCompression.quality
    ? "Качество в проверяемых фактах сохранилось."
    : "Часть фактов потерялась: summary нужно сделать точнее."
);
console.log(
  "Компрессия требует дополнительных summarization-вызовов, но на длинных диалогах уменьшает каждый следующий запрос и предотвращает переполнение окна."
);
