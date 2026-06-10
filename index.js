import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { GigaChatAgent } from "./agent.js";

const useMock = process.argv.includes("--mock");

const agent = new GigaChatAgent({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  historyPath: process.env.CHAT_HISTORY_PATH || "./chat-history.json",
  contextWindow: Number(process.env.GIGACHAT_CONTEXT_WINDOW || 128000),
  maxCompletionTokens: Number(process.env.GIGACHAT_MAX_COMPLETION_TOKENS || 512),
  rubPerMillionTokens: Number(process.env.GIGACHAT_RUB_PER_MILLION_TOKENS || 65),
  mock: useMock
});

if (!useMock && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Ошибка: задайте GIGACHAT_AUTH_KEY или запустите чат с --mock.");
  console.error("Демо без API: npm run chat -- --mock");
  process.exit(1);
}

try {
  await agent.loadHistory();
} catch (error) {
  console.error(`Ошибка загрузки истории: ${error.message}`);
  process.exit(1);
}

const cli = createInterface({ input, output });

console.log(`GigaChat Agent запущен${useMock ? " в mock-режиме" : ""}.`);
console.log(`История загружена: ${agent.history.filter((message) => message.role !== "system").length} сообщений.`);
console.log("Команды: /history, /tokens, /clear, /exit");
output.write("\nВы: ");

for await (const userInput of cli) {
  const command = userInput.trim().toLowerCase();

  if (command === "/exit") {
    break;
  }

  if (command === "/clear") {
    try {
      await agent.clearHistory();
      console.log("История очищена и сохранена.");
    } catch (error) {
      console.error(`Ошибка сохранения истории: ${error.message}`);
    }
    output.write("\nВы: ");
    continue;
  }

  if (command === "/history") {
    const visibleHistory = agent.history.filter((message) => message.role !== "system");

    if (visibleHistory.length === 0) {
      console.log("История пока пуста.");
    } else {
      for (const message of visibleHistory) {
        const author = message.role === "user" ? "Вы" : "Агент";
        console.log(`${author}: ${message.content}`);
      }
    }

    output.write("\nВы: ");
    continue;
  }

  if (command === "/tokens") {
    const totals = agent.usageTotals;
    console.log(
      [
        `Входные токены всех запросов: ${totals.promptTokens}`,
        `Токены всех ответов: ${totals.completionTokens}`,
        `Всего тарифицируемых токенов: ${totals.billedTokens}`,
        `Оценочная стоимость: ${totals.estimatedCostRub.toFixed(6)} ₽`
      ].join("\n")
    );
    output.write("\nВы: ");
    continue;
  }

  try {
    const answer = await agent.chat(userInput);
    console.log(`\nАгент: ${answer}`);
    const metrics = agent.lastMetrics;
    console.log(
      [
        "\nТокены:",
        `  текущий запрос: ${metrics.currentRequestTokens}`,
        `  вся история запроса: ${metrics.historyTokens}`,
        `  ответ модели: ${metrics.answerTokens}`,
        `  заполнение контекста: ${metrics.contextUsagePercent.toFixed(2)}%`,
        `  стоимость вызова: ${metrics.estimatedCostRub.toFixed(6)} ₽`,
        `  накопленная стоимость: ${agent.usageTotals.estimatedCostRub.toFixed(6)} ₽`
      ].join("\n")
    );
  } catch (error) {
    console.error(`\nОшибка: ${error.message}`);
  }

  output.write("\nВы: ");
}

cli.close();
console.log("Чат завершен.");
