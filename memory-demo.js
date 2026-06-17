import { LayeredMemoryAgent } from "./layered-memory-agent.js";

const agent = new LayeredMemoryAgent({
  mock: true,
  memoryPath: `/tmp/layered-memory-demo-${crypto.randomUUID()}.json`,
  shortTermLimit: 4
});
await agent.loadMemory();

console.log("=== Явное сохранение в разные слои ===");
await agent.remember("long", "profile", "Пользователь изучает backend и предпочитает короткие практические примеры.");
await agent.remember("long", "style", "Отвечать по-русски, структурно, без лишней теории.");
await agent.remember("working", "goal", "Подготовить демо агента с memory layers.");
await agent.remember("working", "constraints", "Показать short, working и long память отдельно.");
await agent.chat("Сейчас проверяем модель памяти.");
await agent.chat("Нужно показать, как разные слои влияют на ответ.");

console.log(JSON.stringify(agent.snapshot(), null, 2));

console.log("\n=== Ответ с учетом памяти ===");
console.log(await agent.chat("Сформируй план демонстрации и учти мои предпочтения."));
console.log(`Контекст: ${agent.lastMetrics.historyTokens} токенов`);

console.log("\n=== Проверка содержимого слоев ===");
console.log(await agent.chat("Что ты помнишь по слоям памяти?"));

console.log("\n=== Изменяем рабочую память, долгосрочная остается ===");
await agent.remember("working", "goal", "Подготовить финальный отчет по памяти ассистента.");
console.log(await agent.chat("Сформируй план еще раз."));
console.log(JSON.stringify(agent.snapshot(), null, 2));
