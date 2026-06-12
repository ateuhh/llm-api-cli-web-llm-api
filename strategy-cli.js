import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ContextStrategyAgent } from "./context-strategy-agent.js";

const strategyArgument = process.argv.find((argument) => argument.startsWith("--strategy="));
const strategy = strategyArgument?.split("=")[1] || process.env.CONTEXT_STRATEGY || "sliding";
const useMock = process.argv.includes("--mock");

if (!useMock && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Задайте GIGACHAT_AUTH_KEY или используйте --mock.");
  process.exit(1);
}

const agent = new ContextStrategyAgent({
  strategy,
  windowSize: Number(process.env.CONTEXT_WINDOW_MESSAGES || 6),
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  mock: useMock
});
const cli = createInterface({ input, output });

console.log(`Стратегия: ${agent.strategy}. Окно: ${agent.windowSize} сообщений.`);
console.log("Команды: /facts, /state, /checkpoint NAME, /branch NAME [CHECKPOINT], /switch NAME, /exit");
output.write("\nВы: ");

for await (const line of cli) {
  const text = line.trim();

  if (text === "/exit") {
    break;
  }
  if (text === "/facts") {
    console.log(JSON.stringify(agent.facts, null, 2));
  } else if (text === "/state") {
    console.log(JSON.stringify(agent.strategyState, null, 2));
  } else if (text.startsWith("/checkpoint ")) {
    try {
      agent.createCheckpoint(text.slice("/checkpoint ".length).trim());
      console.log("Checkpoint сохранен.");
    } catch (error) {
      console.error(error.message);
    }
  } else if (text.startsWith("/branch ")) {
    const [name, checkpoint] = text.slice("/branch ".length).trim().split(/\s+/);
    try {
      agent.createBranch(name, checkpoint);
      console.log(`Ветка "${name}" создана.`);
    } catch (error) {
      console.error(error.message);
    }
  } else if (text.startsWith("/switch ")) {
    try {
      agent.switchBranch(text.slice("/switch ".length).trim());
      console.log(`Активная ветка: ${agent.activeBranch}.`);
    } catch (error) {
      console.error(error.message);
    }
  } else {
    try {
      const answer = await agent.chat(text);
      console.log(`\nАгент: ${answer}`);
      console.log(
        `Контекст: ${agent.lastMetrics.historyTokens} токенов; ответ: ${agent.lastMetrics.answerTokens}; ветка: ${agent.activeBranch}`
      );
    } catch (error) {
      console.error(`Ошибка: ${error.message}`);
    }
  }

  output.write("\nВы: ");
}

cli.close();
console.log("Чат завершен.");
