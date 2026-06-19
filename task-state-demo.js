import { TaskStateMachineAgent } from "./task-state-machine-agent.js";

async function createAgent(statePath) {
  const agent = new TaskStateMachineAgent({
    mock: true,
    memoryPath: `/tmp/task-state-memory-${crypto.randomUUID()}.json`,
    statePath
  });
  await agent.loadMemory();
  await agent.loadState();
  return agent;
}

const statePath = `/tmp/task-state-demo-${crypto.randomUUID()}.json`;
let agent = await createAgent(statePath);

console.log("=== Старт задачи: planning ===");
await agent.startTask("Подготовить README для демо", [
  "Собрать требования",
  "Написать раздел запуска",
  "Добавить проверку результата"
]);
await agent.addInvariant({
  type: "fixed",
  key: "архитектура",
  value: "REST API",
  description: "Архитектура зафиксирована: REST API"
});
await agent.addInvariant({
  type: "forbid",
  key: "технология",
  value: "GraphQL",
  description: "GraphQL запрещен в этом проекте"
});
await agent.addInvariant({
  type: "fixed",
  key: "база данных",
  value: "PostgreSQL",
  description: "База данных зафиксирована: PostgreSQL"
});
console.log(JSON.stringify(agent.snapshotState(), null, 2));
console.log(await agent.chat("Что делать дальше?"));

console.log("\n=== Недопустимый переход planning -> validation ===");
try {
  await agent.transitionTo("validation", "Пытаемся пропустить execution");
} catch (error) {
  console.log(`Переход отклонен: ${error.message}`);
}

console.log("\n=== Недопустимый переход planning -> done ===");
try {
  await agent.transitionTo("done", "Пытаемся завершить без выполнения и проверки");
} catch (error) {
  console.log(`Переход отклонен: ${error.message}`);
}

console.log("\n=== Конфликт запроса с инвариантом ===");
console.log(await agent.chat("Давай заменим REST API на GraphQL и MongoDB."));

console.log("\n=== Переход planning -> execution ===");
await agent.advance("План согласован");
console.log(JSON.stringify(agent.snapshotState(), null, 2));

console.log("\n=== Недопустимый переход execution -> done ===");
try {
  await agent.transitionTo("done", "Пытаемся завершить без validation");
} catch (error) {
  console.log(`Переход отклонен: ${error.message}`);
}

console.log("\n=== Пауза на execution ===");
await agent.pause("Пользователь ушел на созвон");
console.log(await agent.chat("Можно остановиться?"));

console.log("\n=== Недопустимый переход во время паузы ===");
try {
  await agent.transitionTo("validation", "Пытаемся перейти дальше во время паузы");
} catch (error) {
  console.log(`Переход отклонен: ${error.message}`);
}

console.log("\n=== Перезапуск приложения ===");
agent = await createAgent(statePath);
console.log(JSON.stringify(agent.snapshotState(), null, 2));

console.log("\n=== Продолжение без повторного объяснения ===");
await agent.resume();
console.log(await agent.chat("Продолжай"));

console.log("\n=== Execution steps -> validation -> done ===");
await agent.advance("Собраны требования");
await agent.advance("Написан раздел запуска");
await agent.advance("Добавлена проверка результата");
console.log(JSON.stringify(agent.snapshotState(), null, 2));
await agent.advance("Проверка успешна");
console.log(JSON.stringify(agent.snapshotState(), null, 2));
console.log(await agent.chat("Итог?"));
