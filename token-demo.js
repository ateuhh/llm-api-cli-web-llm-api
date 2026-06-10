import { GigaChatAgent } from "./agent.js";

function printMetrics(label, agent) {
  const metrics = agent.lastMetrics;
  console.log(`\n=== ${label} ===`);
  console.log(`Текущий запрос: ${metrics.currentRequestTokens} токенов`);
  console.log(`Вся история: ${metrics.historyTokens} токенов`);
  console.log(`Ответ: ${metrics.answerTokens} токенов`);
  console.log(`Заполнение окна: ${metrics.contextUsagePercent.toFixed(2)}%`);
  console.log(`Стоимость вызова: ${metrics.estimatedCostRub.toFixed(6)} ₽`);
  console.log(`Накопленная стоимость: ${agent.usageTotals.estimatedCostRub.toFixed(6)} ₽`);
}

async function createDemoAgent(contextWindow) {
  const agent = new GigaChatAgent({
    mock: true,
    historyPath: `/tmp/gigachat-token-demo-${crypto.randomUUID()}.json`,
    contextWindow,
    maxCompletionTokens: 30
  });
  await agent.loadHistory();
  return agent;
}

const shortAgent = await createDemoAgent(1000);
await shortAgent.chat("Привет! Объясни API одним предложением.");
printMetrics("Короткий диалог", shortAgent);

const longAgent = await createDemoAgent(1000);
for (let index = 1; index <= 6; index += 1) {
  await longAgent.chat(
    `Сообщение ${index}. Продолжай учитывать все предыдущие детали нашего учебного диалога об API.`
  );
}
printMetrics("Длинный диалог", longAgent);

const overflowAgent = await createDemoAgent(120);

try {
  await overflowAgent.chat(
    "Очень длинный запрос для демонстрации переполнения. ".repeat(12)
  );
} catch (error) {
  console.log("\n=== Диалог больше контекстного окна ===");
  console.log(`Ошибка: ${error.message}`);
  console.log("Что ломается: агент не отправляет запрос в LLM, потому что история и резерв ответа не помещаются в окно.");
  console.log("Решение: очистить историю, удалить старые сообщения или сделать их краткое резюме.");
}
