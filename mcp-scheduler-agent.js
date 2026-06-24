import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

class McpSchedulerAgent {
  constructor() {
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["mcp-server.js"],
      stderr: "pipe"
    });
    this.client = new Client({
      name: "llm-api-cli-mcp-scheduler-agent",
      version: "1.0.0"
    });
    this.seenRuns = new Set();
    this.liveUpdatesTimer = null;
    this.liveUpdatesInProgress = false;
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async close() {
    this.stopLiveUpdates();
    await this.transport.close();
  }

  async callJsonTool(name, args = {}) {
    const result = await this.client.callTool({
      name,
      arguments: args
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    return JSON.parse(text);
  }

  async startSummary({ name, interval, cwd }) {
    const result = await this.callJsonTool("schedule_summary", { name, interval, cwd });
    this.markTaskRunsSeen(result.task);
    return [
      result.message,
      `ID: ${result.task.id}`,
      `Интервал: ${result.task.interval}`,
      `Папка: ${result.task.cwd}`,
      `Последняя сводка: ${result.task.lastSummary}`
    ].join("\n");
  }

  async listSummaries() {
    const result = await this.callJsonTool("list_summaries");

    if (result.total === 0) {
      return "Периодических сводок пока нет.";
    }

    const lines = [
      `Всего сводок: ${result.total}. Активных: ${result.active}.`
    ];

    for (const task of result.tasks) {
      lines.push(
        [
          `#${task.id} ${task.name}`,
          `статус: ${task.active ? "активна" : "отключена"}`,
          `интервал: ${task.interval}`,
          `запусков: ${task.runCount}`,
          `последний запуск: ${task.lastRunAt || "еще не было"}`,
          `сводка: ${task.lastSummary}`
        ].join(" | ")
      );
    }

    return lines.join("\n");
  }

  async stopSummary(id) {
    const result = await this.callJsonTool("stop_summary", { id });
    return result.message;
  }

  markTaskRunsSeen(task) {
    for (const run of task.history || task.recentRuns || []) {
      this.seenRuns.add(`${task.id}:${run.at}`);
    }
  }

  markAllRunsSeen(result) {
    for (const task of result.tasks || []) {
      this.markTaskRunsSeen(task);
    }
  }

  formatRun(task, run) {
    return [
      "",
      `[MCP summary #${task.id}: ${task.name}]`,
      `Время: ${run.at}`,
      `Результат: ${run.summary}`
    ].join("\n");
  }

  async loadCurrentRunsAsSeen() {
    const result = await this.callJsonTool("list_summaries");
    this.markAllRunsSeen(result);
  }

  startLiveUpdates({ onUpdate, onError, intervalMs = 1000 }) {
    this.liveUpdatesTimer = setInterval(async () => {
      if (this.liveUpdatesInProgress) {
        return;
      }

      this.liveUpdatesInProgress = true;
      try {
        const result = await this.callJsonTool("list_summaries");
        for (const task of result.tasks || []) {
          for (const run of task.recentRuns || []) {
            const key = `${task.id}:${run.at}`;
            if (!this.seenRuns.has(key)) {
              this.seenRuns.add(key);
              onUpdate(this.formatRun(task, run));
            }
          }
        }
      } catch (error) {
        onError(error);
      } finally {
        this.liveUpdatesInProgress = false;
      }
    }, intervalMs);
  }

  stopLiveUpdates() {
    if (this.liveUpdatesTimer) {
      clearInterval(this.liveUpdatesTimer);
      this.liveUpdatesTimer = null;
    }
  }
}

function parseStartCommand(text) {
  const parts = text
    .slice("/start ".length)
    .split("|")
    .map((part) => part.trim());

  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error("Формат: /start Название | интервал | папка");
  }

  return {
    name: parts[0],
    interval: parts[1],
    cwd: parts[2] || "."
  };
}

function parseStopCommand(text) {
  const id = Number(text.slice("/stop ".length).trim());

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Укажите номер задачи: /stop 1");
  }

  return id;
}

function printHelp() {
  console.log("Команды:");
  console.log("/start Название | интервал | папка — запустить периодическую сводку");
  console.log("/list — показать все периодические сводки");
  console.log("/stop ID — отключить сводку по номеру");
  console.log("/exit — выйти");
  console.log("");
  console.log("Пример:");
  console.log("/start Git каждые 15 секунд | 15s | .");
}

function printPrompt() {
  output.write("\nВы: ");
}

const agent = new McpSchedulerAgent();
const cli = createInterface({ input, output });

try {
  await agent.connect();
  await agent.loadCurrentRunsAsSeen();
  agent.startLiveUpdates({
    onUpdate: (message) => {
      console.log(message);
      printPrompt();
    },
    onError: (error) => {
      console.error(`Ошибка live updates: ${error.message}`);
      printPrompt();
    }
  });
  console.log("MCP Scheduler Agent запущен.");
  console.log("Пока этот процесс работает, активные задачи выполняются по расписанию.");
  console.log("Новые результаты периодических сводок будут автоматически выводиться в чат.");
  printHelp();
  printPrompt();

  for await (const line of cli) {
    const text = line.trim();

    try {
      if (text === "/exit") {
        break;
      } else if (text === "/help") {
        printHelp();
      } else if (text.startsWith("/start ")) {
        console.log(await agent.startSummary(parseStartCommand(text)));
      } else if (text === "/list") {
        console.log(await agent.listSummaries());
      } else if (text.startsWith("/stop ")) {
        console.log(await agent.stopSummary(parseStopCommand(text)));
      } else if (text) {
        console.log("Неизвестная команда. Используйте /help.");
      }
    } catch (error) {
      console.error(`Ошибка: ${error.message}`);
    }

    printPrompt();
  }
} finally {
  cli.close();
  await agent.close();
  console.log("MCP Scheduler Agent завершен.");
}
