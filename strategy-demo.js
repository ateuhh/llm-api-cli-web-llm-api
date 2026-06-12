import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ContextStrategyAgent } from "./context-strategy-agent.js";

const useRealApi = process.argv.includes("--real");
const skipConfirmation = process.argv.includes("--yes");
const expectedFacts = ["сервис управления задачами", "300 000 рублей", "3 месяца", "веб-приложение", "PostgreSQL", "JWT"];
const commonScenario = [
  "Цель: сервис управления задачами.",
  "Бюджет: 300 000 рублей.",
  "Срок: 3 месяца.",
  "Платформа: веб-приложение.",
  "База данных: PostgreSQL.",
  "Авторизация: JWT.",
  "Роли: администратор, менеджер и исполнитель.",
  "Уведомления: email при изменении статуса.",
  "Статусы: создана, в работе, завершена.",
  "Ограничение: не более 50 пользователей на первом этапе.",
  "Решение: REST API и JSON.",
  "Предпочтение: простой интерфейс без сложной анимации."
];
const finalQuestion =
  "Сформируй итоговое ТЗ и обязательно укажи цель, бюджет, срок, платформу, базу данных и авторизацию.";

if (useRealApi && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --real задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

if (useRealApi && !skipConfirmation) {
  console.log("Будет выполнено около 40 реальных запросов к GigaChat для сравнения трех стратегий.");
  console.log("Запросы расходуют API-квоту. Остановить выполнение можно через Ctrl+C.");
  const cli = createInterface({ input, output });
  const answer = await cli.question('Введите "ДА", чтобы продолжить: ');
  cli.close();
  if (answer.trim() !== "ДА") {
    console.log("Тест отменен. Запросы не отправлены.");
    process.exit(0);
  }
}

function createAgent(strategy) {
  return new ContextStrategyAgent({
    strategy,
    windowSize: 6,
    authKey: process.env.GIGACHAT_AUTH_KEY,
    model: process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
    mock: !useRealApi
  });
}

function quality(answer) {
  const normalized = answer.toLowerCase().replace(/\s+/g, " ");
  return expectedFacts.filter((fact) =>
    normalized.includes(fact.toLowerCase().replace(/\s+/g, " "))
  ).length;
}

async function runLinear(strategy) {
  const agent = createAgent(strategy);
  for (const message of commonScenario) {
    await agent.chat(message);
  }
  const answer = await agent.chat(finalQuestion);
  return {
    answer,
    quality: quality(answer),
    contextTokens: agent.lastMetrics.historyTokens,
    billedTokens: agent.usageTotals.billedTokens,
    cost: agent.usageTotals.estimatedCostRub,
    retainedMessages: agent.activeMessages.length,
    facts: agent.facts
  };
}

async function runBranching() {
  const agent = createAgent("branching");

  for (const message of commonScenario.slice(0, 6)) {
    await agent.chat(message);
  }
  agent.createCheckpoint("base");
  agent.createBranch("web", "base");
  agent.createBranch("mobile", "base");

  agent.switchBranch("web");
  for (const message of commonScenario.slice(6)) {
    await agent.chat(message);
  }
  const webAnswer = await agent.chat(finalQuestion);
  const webTokens = agent.lastMetrics.historyTokens;

  agent.switchBranch("mobile");
  const mobileScenario = [
    "Роли: владелец, менеджер и исполнитель.",
    "Уведомления: push при изменении статуса.",
    "Статусы: создана, в работе, завершена.",
    "Ограничение: первая версия только для iOS.",
    "Решение: мобильный клиент и REST API.",
    "Предпочтение: навигация нижними вкладками."
  ];
  for (const message of mobileScenario) {
    await agent.chat(message);
  }
  const mobileAnswer = await agent.chat(finalQuestion);

  return {
    answer: `WEB: ${webAnswer}\nMOBILE: ${mobileAnswer}`,
    quality: Math.min(quality(webAnswer), quality(mobileAnswer)),
    contextTokens: Math.max(webTokens, agent.lastMetrics.historyTokens),
    billedTokens: agent.usageTotals.billedTokens,
    cost: agent.usageTotals.estimatedCostRub,
    retainedMessages: Object.values(agent.branches).reduce(
      (sum, messages) => sum + messages.length,
      0
    ),
    branchesIndependent:
      webAnswer.includes("web") === false &&
      mobileAnswer.includes("Ветка: mobile")
  };
}

function printResult(name, result, stability, convenience, notes) {
  console.log(`\n=== ${name} ===`);
  console.log(`Ответ: ${result.answer}`);
  console.log(`Качество: ${result.quality}/${expectedFacts.length} ключевых фактов`);
  console.log(`Стабильность: ${stability}`);
  console.log(`Контекст финального запроса: ${result.contextTokens} токенов`);
  console.log(`Тарифицируемые токены сценария: ${result.billedTokens}`);
  console.log(`Оценочная стоимость: ${result.cost.toFixed(6)} ₽`);
  console.log(`Сообщений в памяти: ${result.retainedMessages}`);
  console.log(`Удобство: ${convenience}`);
  console.log(`Поведение: ${notes}`);
}

try {
  const sliding = await runLinear("sliding");
  const facts = await runLinear("facts");
  const branching = await runBranching();

  console.log(`Режим: ${useRealApi ? "реальный GigaChat API" : "mock"}`);
  printResult(
    "Sliding Window",
    sliding,
    "низкая для ранних деталей",
    "высокое: стратегия не требует ручного управления",
    "Самый простой и экономный подход, но ранние требования отбрасываются."
  );
  printResult(
    "Sticky Facts",
    facts,
    "высокая для структурированных ключевых данных",
    "высокое: достаточно вводить важные данные как ключ: значение",
    `Ключевые данные сохранены отдельно: ${JSON.stringify(facts.facts)}`
  );
  printResult(
    "Branching",
    branching,
    "высокая внутри каждой ветки, решения веток не смешиваются",
    "среднее: пользователь управляет checkpoint и активной веткой",
    "Ветки web и mobile продолжаются независимо от общего checkpoint."
  );

  console.log("\n=== Сравнение ===");
  console.log("Sliding Window: минимальный контекст и простое поведение, но низкая стабильность важных ранних деталей.");
  console.log("Sticky Facts: лучший баланс стабильности и токенов для последовательного сбора ТЗ.");
  console.log("Branching: удобнее всего для параллельного сравнения вариантов, но хранит больше данных и расходует больше токенов.");
} catch (error) {
  console.error(`Тест остановлен: ${error.message}`);
  process.exit(1);
}
