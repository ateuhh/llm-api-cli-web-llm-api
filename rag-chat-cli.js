import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { RagMemoryChat } from "./rag-memory-chat.js";

const useRealApi = process.argv.includes("--real");

if (useRealApi && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --real задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

const chat = new RagMemoryChat({
  statePath: process.env.RAG_CHAT_STATE_PATH || "rag-chat-state.json",
  ragOptions: {
    mock: !useRealApi,
    relevanceThreshold: Number(process.env.RAG_CHAT_RELEVANCE_THRESHOLD || 0.35),
    authKey: process.env.GIGACHAT_AUTH_KEY,
    model: process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
  }
});
await chat.init();

const cli = createInterface({ input, output });

console.log("RAG memory chat запущен.");
console.log("Команды: /memory, /history, /reset, /exit");

while (true) {
  let userInput;
  try {
    userInput = (await cli.question("\nВы: ")).trim();
  } catch (error) {
    if (error.code === "ERR_USE_AFTER_CLOSE") {
      break;
    }
    throw error;
  }

  if (!userInput) {
    continue;
  }
  if (userInput === "/exit") {
    break;
  }
  if (userInput === "/memory") {
    console.log("\nПамять задачи:");
    console.log(chat.formatTaskMemory());
    continue;
  }
  if (userInput === "/history") {
    const state = chat.getStateSnapshot();
    console.log(`\nСообщений в истории: ${state.messages.length}`);
    for (const message of state.messages.slice(-10)) {
      console.log(`- ${message.role}: ${message.content.slice(0, 220)}`);
    }
    continue;
  }
  if (userInput === "/reset") {
    await chat.reset();
    console.log("История и память задачи очищены.");
    continue;
  }

  try {
    const result = await chat.ask(userInput);
    console.log("\nАссистент:");
    console.log(result.answer);
    console.log("\nПамять задачи:");
    console.log(chat.formatTaskMemory());
    console.log(`\nИстория: ${result.historyLength} сообщений`);
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
  }
}

cli.close();
console.log("RAG memory chat завершен.");
