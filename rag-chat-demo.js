import { RagMemoryChat } from "./rag-memory-chat.js";

const useRealApi = process.argv.includes("--real");

if (useRealApi && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --real задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

const scenarios = [
  {
    name: "ТЗ для демонстрации MCP orchestration",
    statePath: "rag-chat-demo-orchestration.json",
    messages: [
      "Цель: подготовить демонстрацию MCP orchestration на реальных данных проекта.",
      "Ограничение: показывать только команды, которые реально есть в package.json.",
      "Термин: orchestration означает выбор инструментов из нескольких MCP-серверов.",
      "Какие MCP-серверы используются в orchestration?",
      "Решение: в сценарии нужно показать порядок вызовов инструментов.",
      "Какая команда запускает orchestration агент?",
      "Ограничение: итог должен быть понятен для записи видео.",
      "Что пользователь должен ввести, чтобы агент сам выбрал search и save?",
      "Фиксируем: надо показать trace и итоговый файл.",
      "Какие источники подтверждают наличие git_status и search_project_files?",
      "Собери короткий план демонстрации с учетом цели и ограничений.",
      "Проверь, не потерял ли ты цель диалога и ограничения."
    ]
  },
  {
    name: "ТЗ для RAG с цитатами и анти-галлюцинациями",
    statePath: "rag-chat-demo-grounding.json",
    messages: [
      "Цель: подготовить production-like RAG чат с памятью и источниками.",
      "Ограничение: каждый ответ обязан выводить источники и цитаты.",
      "Термин: grounding означает проверку, что ответ подтвержден цитатами.",
      "Какие блоки должен возвращать улучшенный RAG?",
      "Решение: если контекст слабый, ассистент должен сказать не знаю.",
      "Какой порог релевантности используется в фильтре?",
      "Ограничение: нельзя отвечать фактами без найденных чанков.",
      "Как проверить weak-context режим на странном вопросе?",
      "Фиксируем: в отчете нужен итог Grounding 10/10.",
      "Какая команда запускает полный RAG demo?",
      "Собери сценарий демонстрации этого чата.",
      "Проверь, сохранилась ли цель и правило про источники."
    ]
  }
];

function printCompactAnswer(result) {
  const answerLines = result.answer.split("\n");
  const sourceLines = answerLines.filter((line) => /^- .+chunk_id=/.test(line));
  const quoteLines = answerLines.filter((line) => /^- «/.test(line));

  console.log(answerLines.slice(0, 8).join("\n"));
  console.log(`Источников в ответе: ${sourceLines.length}`);
  console.log(`Цитат в ответе: ${quoteLines.length}`);
  console.log(
    `Grounding: sources=${result.grounding.hasSources ? "yes" : "no"}, citations=${result.grounding.hasCitations ? "yes" : "no"}`
  );
}

async function runScenario(scenario, index) {
  console.log(`\n=== Сценарий ${index}: ${scenario.name} ===`);
  const chat = new RagMemoryChat({
    statePath: scenario.statePath,
    ragOptions: {
      mock: !useRealApi,
      relevanceThreshold: Number(process.env.RAG_CHAT_RELEVANCE_THRESHOLD || 0.35),
      authKey: process.env.GIGACHAT_AUTH_KEY,
      model: process.env.GIGACHAT_MODEL || "GigaChat-2",
      scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
    }
  });
  await chat.init();
  await chat.reset();

  const checks = [];

  for (const [messageIndex, message] of scenario.messages.entries()) {
    console.log(`\n[${messageIndex + 1}/${scenario.messages.length}] Пользователь: ${message}`);
    const result = await chat.ask(message);
    printCompactAnswer(result);
    checks.push({
      hasSources: result.sources.length > 0 && result.grounding.hasSources,
      hasCitations: result.citations.length > 0 && result.grounding.hasCitations,
      goalKept: Boolean(result.taskMemory.goal),
      memoryItems:
        result.taskMemory.clarifications.length +
        result.taskMemory.constraints.length +
        result.taskMemory.terms.length +
        result.taskMemory.decisions.length
    });
  }

  const finalState = chat.getStateSnapshot();
  const sourceOk = checks.filter((item) => item.hasSources).length;
  const citationOk = checks.filter((item) => item.hasCitations).length;
  const goalOk = checks.every((item) => item.goalKept);

  console.log("\nИтог памяти задачи:");
  console.log(chat.formatTaskMemory());
  console.log(`Сообщений в истории: ${finalState.messages.length}`);
  console.log(`Ответы с источниками: ${sourceOk}/${checks.length}`);
  console.log(`Ответы с цитатами: ${citationOk}/${checks.length}`);
  console.log(`Цель не потеряна: ${goalOk ? "да" : "нет"}`);

  return { sourceOk, citationOk, goalOk, total: checks.length };
}

const results = [];
for (const [index, scenario] of scenarios.entries()) {
  results.push(await runScenario(scenario, index + 1));
}

const total = results.reduce((sum, item) => sum + item.total, 0);
const sources = results.reduce((sum, item) => sum + item.sourceOk, 0);
const citations = results.reduce((sum, item) => sum + item.citationOk, 0);
const goals = results.filter((item) => item.goalOk).length;

console.log("\n=== Итоговая проверка production-like RAG chat ===");
console.log(`Ответы с источниками: ${sources}/${total}`);
console.log(`Ответы с цитатами: ${citations}/${total}`);
console.log(`Сценарии, где цель сохранена: ${goals}/${results.length}`);
console.log(
  sources === total && citations === total && goals === results.length
    ? "Мини-чат сохраняет память задачи и отвечает с источниками."
    : "Есть провал проверки, нужно смотреть вывод выше."
);
