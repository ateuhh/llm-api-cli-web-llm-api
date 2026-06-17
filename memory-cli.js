import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { LayeredMemoryAgent } from "./layered-memory-agent.js";

const useMock = process.argv.includes("--mock");

if (!useMock && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Задайте GIGACHAT_AUTH_KEY или используйте --mock.");
  process.exit(1);
}

const agent = new LayeredMemoryAgent({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  mock: useMock,
  memoryPath: process.env.MEMORY_PATH || "./memory-layers.json",
  shortTermLimit: Number(process.env.SHORT_MEMORY_LIMIT || 8)
});

try {
  await agent.loadMemory();
} catch (error) {
  console.error(`Ошибка загрузки памяти: ${error.message}`);
  process.exit(1);
}

function printHelp() {
  console.log("Команды:");
  console.log("/remember short ROLE TEXT");
  console.log("/remember working KEY VALUE");
  console.log("/remember long KEY VALUE");
  console.log("/memory");
  console.log("/forget working KEY");
  console.log("/forget long KEY");
  console.log("/clear-memory");
  console.log("/exit");
}

const cli = createInterface({ input, output });
console.log(`Layered Memory Agent запущен${useMock ? " в mock-режиме" : ""}.`);
console.log(`Файл памяти: ${agent.memoryPath}`);
printHelp();
output.write("\nВы: ");

for await (const line of cli) {
  const text = line.trim();

  if (text === "/exit") {
    break;
  }

  if (text === "/memory") {
    console.log(JSON.stringify(agent.snapshot(), null, 2));
  } else if (text === "/clear-memory") {
    await agent.clearMemory();
    console.log("Все слои памяти очищены.");
  } else if (text.startsWith("/remember ")) {
    const [, layer, key, ...valueParts] = text.split(" ");
    try {
      await agent.remember(layer, key, valueParts.join(" "));
      console.log(`Сохранено в слой ${layer}: ${key}`);
    } catch (error) {
      console.error(error.message);
    }
  } else if (text.startsWith("/forget ")) {
    const [, layer, key] = text.split(" ");
    try {
      await agent.forget(layer, key);
      console.log(`Удалено из слоя ${layer}: ${key || "short"}`);
    } catch (error) {
      console.error(error.message);
    }
  } else if (text === "/help") {
    printHelp();
  } else {
    try {
      const answer = await agent.chat(text);
      console.log(`\nАгент: ${answer}`);
      console.log(
        `Память: short=${agent.lastMetrics.shortMessages}, working=${agent.lastMetrics.workingKeys}, long=${agent.lastMetrics.longKeys}; контекст=${agent.lastMetrics.historyTokens} токенов`
      );
    } catch (error) {
      console.error(`Ошибка: ${error.message}`);
    }
  }

  output.write("\nВы: ");
}

cli.close();
console.log("Чат завершен.");
