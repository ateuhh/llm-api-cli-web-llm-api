import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { OllamaAgent } from "./ollama-agent.js";

const agent = new OllamaAgent();

try {
  await agent.assertReady();
} catch (error) {
  console.error(`Ошибка запуска локальной LLM: ${error.message}`);
  console.error("Проверьте, что Ollama запущена: ollama serve");
  process.exit(1);
}

const cli = createInterface({ input, output });

console.log("Local LLM CLI запущен.");
console.log(`Ollama: ${agent.baseUrl}`);
console.log(`Модель: ${agent.model}`);
console.log("Команды: /history, /clear, /exit");
output.write("\nВы: ");

for await (const line of cli) {
  const userInput = line.trim();

  if (!userInput) {
    output.write("\nВы: ");
    continue;
  }

  if (userInput === "/exit") {
    break;
  }

  if (userInput === "/clear") {
    agent.clear();
    console.log("История текущего сеанса очищена.");
    output.write("\nВы: ");
    continue;
  }

  if (userInput === "/history") {
    const history = agent.visibleHistory();
    if (history.length === 0) {
      console.log("История текущего сеанса пока пуста.");
      output.write("\nВы: ");
      continue;
    }

    for (const message of history) {
      const author = message.role === "user" ? "Вы" : "Ассистент";
      console.log(`${author}: ${message.content}`);
    }
    output.write("\nВы: ");
    continue;
  }

  try {
    const result = await agent.chat(userInput);
    console.log("\nАссистент:");
    console.log(result.answer);
    console.log(
      [
        "\nЛокальная LLM:",
        `  модель: ${result.model}`,
        `  prompt tokens: ${result.promptTokens}`,
        `  completion tokens: ${result.completionTokens}`,
        `  время ответа: ${result.totalDurationMs} мс`
      ].join("\n")
    );
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
  }

  output.write("\nВы: ");
}

cli.close();
console.log("Local LLM CLI завершен.");
