import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TaskStateMachineAgent } from "./task-state-machine-agent.js";

const useMock = process.argv.includes("--mock");

if (!useMock && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Задайте GIGACHAT_AUTH_KEY или используйте --mock.");
  process.exit(1);
}

const agent = new TaskStateMachineAgent({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  mock: useMock,
  memoryPath: process.env.MEMORY_PATH || "./memory-layers.json",
  statePath: process.env.TASK_STATE_PATH || "./task-state.json"
});

await agent.loadMemory();
await agent.loadState();

const cli = createInterface({ input, output });

console.log(`Task State Machine Agent запущен${useMock ? " в mock-режиме" : ""}.`);
console.log("Команды: /start TASK | step1; step2, /state, /advance NOTE, /pause REASON, /resume, /exit");
output.write("\nВы: ");

for await (const line of cli) {
  const text = line.trim();

  if (text === "/exit") {
    break;
  }

  if (text === "/state") {
    console.log(JSON.stringify(agent.snapshotState(), null, 2));
  } else if (text.startsWith("/start ")) {
    const [taskName, planText = ""] = text.slice("/start ".length).split("|");
    const plan = planText
      .split(";")
      .map((step) => step.trim())
      .filter(Boolean);
    await agent.startTask(taskName.trim(), plan);
    console.log("Задача создана.");
    console.log(JSON.stringify(agent.snapshotState(), null, 2));
  } else if (text.startsWith("/advance")) {
    const note = text.slice("/advance".length).trim();
    await agent.advance(note);
    console.log("Переход выполнен.");
    console.log(JSON.stringify(agent.snapshotState(), null, 2));
  } else if (text.startsWith("/pause")) {
    const reason = text.slice("/pause".length).trim();
    await agent.pause(reason);
    console.log("Пауза сохранена.");
    console.log(JSON.stringify(agent.snapshotState(), null, 2));
  } else if (text === "/resume") {
    await agent.resume();
    console.log("Продолжаем без повторного объяснения.");
    console.log(JSON.stringify(agent.snapshotState(), null, 2));
  } else {
    const answer = await agent.chat(text);
    console.log(`\nАгент: ${answer}`);
  }

  output.write("\nВы: ");
}

cli.close();
console.log("Чат завершен.");
