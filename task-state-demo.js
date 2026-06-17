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
console.log(JSON.stringify(agent.snapshotState(), null, 2));
console.log(await agent.chat("Что делать дальше?"));

console.log("\n=== Переход planning -> execution ===");
await agent.advance("План согласован");
console.log(JSON.stringify(agent.snapshotState(), null, 2));

console.log("\n=== Пауза на execution ===");
await agent.pause("Пользователь ушел на созвон");
console.log(await agent.chat("Можно остановиться?"));

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
