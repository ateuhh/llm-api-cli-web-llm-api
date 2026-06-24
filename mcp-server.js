import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const schedulerStatePath = process.env.MCP_SCHEDULER_STATE_PATH || "./mcp-scheduler-tasks.json";
const scheduledIntervals = new Map();

const server = new McpServer({
  name: "llm-api-cli-local-mcp-server",
  version: "1.0.0"
});

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function createInitialSchedulerState() {
  return {
    nextId: 1,
    tasks: []
  };
}

async function loadSchedulerState() {
  try {
    const rawState = await readFile(schedulerStatePath, "utf8");
    const state = JSON.parse(rawState);
    return {
      ...createInitialSchedulerState(),
      ...state,
      tasks: Array.isArray(state.tasks) ? state.tasks : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return createInitialSchedulerState();
    }
    throw error;
  }
}

async function saveSchedulerState(state) {
  const temporaryPath = `${schedulerStatePath}.tmp`;
  await mkdir(dirname(schedulerStatePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryPath, schedulerStatePath);
}

function parseIntervalToMs(value) {
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+)\s*(ms|мс|s|sec|secs|second|seconds|сек|секунд|m|min|minute|minutes|мин|минут|h|hr|hour|hours|ч|час|часов|d|day|days|д|день|дней)?$/);

  if (!match) {
    throw new Error(
      "Интервал должен быть в формате: 15s, 1 minute, 24 hours, 10 секунд, 5 минут."
    );
  }

  const amount = Number(match[1]);
  const unit = match[2] || "ms";
  const multipliers = {
    ms: 1,
    "мс": 1,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    "сек": 1000,
    "секунд": 1000,
    m: 60_000,
    min: 60_000,
    minute: 60_000,
    minutes: 60_000,
    "мин": 60_000,
    "минут": 60_000,
    h: 3_600_000,
    hr: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    "ч": 3_600_000,
    "час": 3_600_000,
    "часов": 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    "д": 86_400_000,
    "день": 86_400_000,
    "дней": 86_400_000
  };
  const intervalMs = amount * multipliers[unit];

  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    throw new Error("Минимальный интервал для фоновой задачи: 1 секунда.");
  }

  return intervalMs;
}

async function buildGitSummary(cwd) {
  try {
    const [branch, status] = await Promise.all([
      git(["branch", "--show-current"], cwd),
      git(["status", "--short"], cwd)
    ]);
    const changedFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      ok: true,
      branch: branch || "(detached)",
      clean: changedFiles.length === 0,
      changedFiles,
      summary: changedFiles.length === 0
        ? `Ветка ${branch || "(detached)"}: рабочее дерево чистое.`
        : `Ветка ${branch || "(detached)"}: изменений ${changedFiles.length}. ${changedFiles.join(", ")}`
    };
  } catch (error) {
    return {
      ok: false,
      branch: "",
      clean: false,
      changedFiles: [],
      summary: `Не удалось собрать Git summary: ${error.message}`
    };
  }
}

async function runScheduledTask(taskId) {
  const state = await loadSchedulerState();
  const task = state.tasks.find((item) => item.id === taskId);

  if (!task || !task.active) {
    return null;
  }

  const collected = await buildGitSummary(task.cwd);
  const run = {
    at: new Date().toISOString(),
    summary: collected.summary,
    branch: collected.branch,
    clean: collected.clean,
    changedFiles: collected.changedFiles
  };
  task.lastRunAt = run.at;
  task.lastSummary = run.summary;
  task.runCount += 1;
  task.history = [...(task.history || []), run].slice(-20);
  await saveSchedulerState(state);
  return task;
}

function scheduleTask(task) {
  if (scheduledIntervals.has(task.id)) {
    clearInterval(scheduledIntervals.get(task.id));
  }

  const timer = setInterval(() => {
    runScheduledTask(task.id).catch((error) => {
      console.error(`Scheduler task ${task.id} failed:`, error.message);
    });
  }, task.intervalMs);
  timer.unref?.();
  scheduledIntervals.set(task.id, timer);
}

async function restoreActiveSchedules() {
  const state = await loadSchedulerState();
  for (const task of state.tasks) {
    if (task.active) {
      scheduleTask(task);
    }
  }
}

function schedulerResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.registerTool(
  "echo",
  {
    description: "Возвращает переданный текст без изменений.",
    inputSchema: {
      text: z.string().describe("Текст, который нужно вернуть.")
    }
  },
  async ({ text }) => ({
    content: [{ type: "text", text }]
  })
);

server.registerTool(
  "project_info",
  {
    description: "Возвращает краткую информацию о demo-проекте.",
    inputSchema: {}
  },
  async () => ({
    content: [
      {
        type: "text",
        text: "Проект демонстрирует LLM API, агентов, память, состояния и MCP-подключение."
      }
    ]
  })
);

server.registerTool(
  "git_status",
  {
    description: "Возвращает статус Git-репозитория для указанной папки.",
    inputSchema: {
      cwd: z.string().default(".").describe("Путь к Git-репозиторию."),
      includeUntracked: z
        .boolean()
        .default(true)
        .describe("Показывать ли untracked-файлы.")
    }
  },
  async ({ cwd, includeUntracked }) => {
    const statusArgs = includeUntracked
      ? ["status", "--short"]
      : ["status", "--short", "--untracked-files=no"];
    const [branch, status] = await Promise.all([
      git(["branch", "--show-current"], cwd),
      git(statusArgs, cwd)
    ]);
    const files = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const result = {
      cwd,
      branch: branch || "(detached)",
      clean: files.length === 0,
      changedFiles: files
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "schedule_summary",
  {
    description: "Запускает периодическую Git-сводку по расписанию и сохраняет результаты в JSON.",
    inputSchema: {
      name: z.string().min(1).describe("Человекочитаемое название периодической сводки."),
      interval: z.string().min(1).describe("Интервал: например 15s, 1 minute, 24 hours."),
      cwd: z.string().default(".").describe("Папка Git-репозитория для сбора сводки.")
    }
  },
  async ({ name, interval, cwd }) => {
    const intervalMs = parseIntervalToMs(interval);
    const state = await loadSchedulerState();
    const task = {
      id: state.nextId,
      name,
      cwd,
      interval,
      intervalMs,
      active: true,
      createdAt: new Date().toISOString(),
      lastRunAt: null,
      lastSummary: "Сводка еще не выполнялась.",
      runCount: 0,
      history: []
    };
    state.nextId += 1;
    state.tasks.push(task);
    await saveSchedulerState(state);
    scheduleTask(task);
    const updatedTask = await runScheduledTask(task.id);

    return schedulerResult({
      message: `Периодическая сводка "${name}" запущена.`,
      task: updatedTask || task
    });
  }
);

server.registerTool(
  "list_summaries",
  {
    description: "Возвращает все периодические сводки и агрегированный результат по каждой.",
    inputSchema: {}
  },
  async () => {
    const state = await loadSchedulerState();
    return schedulerResult({
      total: state.tasks.length,
      active: state.tasks.filter((task) => task.active).length,
      tasks: state.tasks.map((task) => ({
        id: task.id,
        name: task.name,
        cwd: task.cwd,
        interval: task.interval,
        active: task.active,
        runCount: task.runCount,
        lastRunAt: task.lastRunAt,
        lastSummary: task.lastSummary,
        recentRuns: (task.history || []).slice(-3)
      }))
    });
  }
);

server.registerTool(
  "stop_summary",
  {
    description: "Отключает периодическую сводку по числовому id.",
    inputSchema: {
      id: z.number().int().positive().describe("Номер периодической сводки.")
    }
  },
  async ({ id }) => {
    const state = await loadSchedulerState();
    const task = state.tasks.find((item) => item.id === id);

    if (!task) {
      return schedulerResult({
        ok: false,
        message: `Задача с id ${id} не найдена. Используйте команду списка, чтобы увидеть доступные id.`
      });
    }

    task.active = false;
    task.stoppedAt = new Date().toISOString();
    if (scheduledIntervals.has(id)) {
      clearInterval(scheduledIntervals.get(id));
      scheduledIntervals.delete(id);
    }
    await saveSchedulerState(state);

    return schedulerResult({
      ok: true,
      message: `Периодическая сводка #${id} "${task.name}" отключена.`,
      task
    });
  }
);

const transport = new StdioServerTransport();
await restoreActiveSchedules();
await server.connect(transport);
