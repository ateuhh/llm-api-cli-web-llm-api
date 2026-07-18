import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_OUTPUT_DIR = "file-assistant-output";

function parseArgs(argv) {
  const goalIndex = argv.indexOf("--goal");
  return {
    goal: goalIndex >= 0 ? argv[goalIndex + 1] : ""
  };
}

async function git(args, cwd = ".") {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024
  });
  return stdout.trim();
}

class McpFilesClient {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["mcp-files-server.js"],
      stderr: "pipe"
    });
    this.client = new Client({
      name: "project-file-assistant",
      version: "1.0.0"
    });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async close() {
    await this.transport.close();
  }

  async callJsonTool(name, args = {}) {
    const result = await this.client.callTool({
      name,
      arguments: {
        cwd: this.cwd,
        ...args
      }
    });
    const text = result.content.find((item) => item.type === "text")?.text || "{}";
    return JSON.parse(text);
  }

  async listFiles(maxResults = 120) {
    return this.callJsonTool("list_project_files", { maxResults });
  }

  async readFile(path, maxChars = 16000) {
    return this.callJsonTool("read_project_file", { path, maxChars });
  }

  async search(query, maxResults = 30) {
    return this.callJsonTool("search_project_files", { query, maxResults });
  }

  async summarize({ title, query, searchResult, maxLines = 10 }) {
    return this.callJsonTool("summarize_text", {
      title,
      query,
      matchesJson: JSON.stringify(searchResult),
      maxLines
    });
  }

  async save(path, content, append = false) {
    return this.callJsonTool("save_to_file", { path, content, append });
  }
}

class ProjectFileAssistant {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.files = new McpFilesClient({ cwd });
  }

  async connect() {
    await this.files.connect();
  }

  async close() {
    await this.files.close();
  }

  async run(goal) {
    const normalized = goal.toLowerCase();

    if (/найди|найти|использован|usage|где.*использ/i.test(normalized)) {
      return this.findUsages(goal);
    }

    if (/обнови|обновить|документац|readme|docs/i.test(normalized)) {
      return this.updateDocumentation(goal);
    }

    if (/adr|решени|архитектур/i.test(normalized)) {
      return this.generateAdr(goal);
    }

    return this.prepareProjectSnapshot(goal);
  }

  async findUsages(goal) {
    const query = this.extractQuery(goal);
    const trace = [];
    const searchResult = await this.record(trace, "search_project_files", `ищу использования "${query}"`, () =>
      this.files.search(query, 40)
    );
    const uniqueFiles = [...new Set(searchResult.matches.map((match) => match.file))]
      .slice(0, 6)
      .map((file) => this.relativeProjectPath(file));
    const fileReads = [];

    for (const file of uniqueFiles) {
      fileReads.push(await this.record(trace, "read_project_file", `читаю найденный файл ${file}`, () =>
        this.files.readFile(file, 9000)
      ));
    }

    const summary = await this.record(trace, "summarize_text", "собираю сводку по найденным строкам", () =>
      this.files.summarize({
        title: `Usage report for ${query}`,
        query,
        searchResult,
        maxLines: 12
      })
    );
    const reportPath = `${DEFAULT_OUTPUT_DIR}/usage-${this.slug(query)}.md`;
    const report = this.buildUsageReport({ goal, query, searchResult, fileReads, summary, trace });
    await this.record(trace, "save_to_file", `сохраняю отчет ${reportPath}`, () =>
      this.files.save(reportPath, report)
    );

    return this.finish({
      title: "Поиск использований",
      trace,
      outputPath: reportPath
    });
  }

  async updateDocumentation(goal) {
    const trace = [];
    const files = await this.record(trace, "list_project_files", "получаю список файлов проекта", () =>
      this.files.listFiles(160)
    );
    const importantFiles = [
      "package.json",
      "README.md",
      "mcp-files-server.js",
      "file-assistant.js",
      "project/docs/architecture.md",
      "project/docs/api.md"
    ].filter((file) => files.files.includes(file));
    const reads = [];

    for (const file of importantFiles) {
      reads.push(await this.record(trace, "read_project_file", `читаю ${file}`, () =>
        this.files.readFile(file, 14000)
      ));
    }

    const docPath = "project/docs/file-assistant.md";
    const content = this.buildFileAssistantDoc({ goal, files: files.files, reads, trace });
    await this.record(trace, "save_to_file", `обновляю документацию ${docPath}`, () =>
      this.files.save(docPath, content)
    );

    return this.finish({
      title: "Обновление документации",
      trace,
      outputPath: docPath,
      diffPath: docPath
    });
  }

  async generateAdr(goal) {
    const trace = [];
    const files = await this.record(trace, "list_project_files", "получаю структуру проекта", () =>
      this.files.listFiles(120)
    );
    const readme = await this.record(trace, "read_project_file", "читаю README для контекста", () =>
      this.files.readFile("README.md", 12000)
    );
    const adrPath = `${DEFAULT_OUTPUT_DIR}/adr-file-assistant.md`;
    const content = this.buildAdr({ goal, files: files.files, readme, trace });
    await this.record(trace, "save_to_file", `сохраняю ADR ${adrPath}`, () =>
      this.files.save(adrPath, content)
    );

    return this.finish({
      title: "Генерация ADR",
      trace,
      outputPath: adrPath
    });
  }

  async prepareProjectSnapshot(goal) {
    const trace = [];
    const files = await this.record(trace, "list_project_files", "получаю список файлов", () =>
      this.files.listFiles(100)
    );
    const packageJson = await this.record(trace, "read_project_file", "читаю package.json", () =>
      this.files.readFile("package.json", 10000)
    );
    const readme = await this.record(trace, "read_project_file", "читаю README.md", () =>
      this.files.readFile("README.md", 14000)
    );
    const outputPath = `${DEFAULT_OUTPUT_DIR}/project-snapshot.md`;
    const content = this.buildSnapshot({ goal, files: files.files, packageJson, readme, trace });
    await this.record(trace, "save_to_file", `сохраняю snapshot ${outputPath}`, () =>
      this.files.save(outputPath, content)
    );

    return this.finish({
      title: "Снимок проекта",
      trace,
      outputPath
    });
  }

  async record(trace, tool, reason, action) {
    const startedAt = new Date().toISOString();
    const result = await action();
    trace.push({
      step: trace.length + 1,
      tool,
      reason,
      startedAt,
      result: this.compactResult(tool, result)
    });
    return result;
  }

  compactResult(tool, result) {
    if (tool === "list_project_files") {
      return `файлов: ${result.total}, показано: ${result.files.length}`;
    }
    if (tool === "read_project_file") {
      return `${result.path}, символов: ${result.chars}${result.truncated ? " (обрезано)" : ""}`;
    }
    if (tool === "search_project_files") {
      return `совпадений: ${result.total}`;
    }
    if (tool === "summarize_text") {
      return `строк источника: ${result.sourceMatches}`;
    }
    if (tool === "save_to_file") {
      return `${result.path}, байт: ${result.bytes}`;
    }
    return JSON.stringify(result).slice(0, 200);
  }

  async finish({ title, trace, outputPath, diffPath = outputPath }) {
    const isTracked = await git(["ls-files", "--error-unmatch", diffPath], this.cwd)
      .then(() => true)
      .catch(() => false);
    const diff = isTracked
      ? await git(["diff", "--", diffPath], this.cwd).catch((error) =>
          `Не удалось получить diff: ${error.message}`
        )
      : "";
    const newFilePreview = isTracked
      ? ""
      : await this.files.readFile(diffPath, 6000)
        .then((file) => file.content)
        .catch(() => "");
    return [
      `# ${title}`,
      "",
      "Порядок действий:",
      ...trace.map((item) => `${item.step}. ${item.tool} — ${item.reason}; результат: ${item.result}`),
      "",
      `Результат сохранен: ${outputPath}`,
      "",
      isTracked ? "Diff:" : "Новый файл:",
      isTracked
        ? (diff ? this.truncate(diff, 6000) : "Файл отслеживается Git, но diff пуст.")
        : this.truncate(newFilePreview, 6000)
    ].join("\n");
  }

  buildUsageReport({ goal, query, searchResult, fileReads, summary, trace }) {
    const files = [...new Set(searchResult.matches.map((match) => this.relativeProjectPath(match.file)))];
    return [
      "# File Assistant Usage Report",
      "",
      `Цель: ${goal}`,
      `Запрос: ${query}`,
      `Найдено совпадений: ${searchResult.total}`,
      "",
      "## Файлы",
      ...files.map((file) => `- ${file}`),
      "",
      "## Совпадения",
      ...searchResult.matches.slice(0, 30).map((match) =>
        `- ${this.relativeProjectPath(match.file)}:${match.line} — ${match.text}`
      ),
      "",
      "## Сводка MCP",
      summary.summary,
      "",
      "## Прочитанные файлы",
      ...fileReads.map((file) => `- ${file.path}: ${file.chars} символов`),
      "",
      "## Trace",
      ...trace.map((item) => `${item.step}. ${item.tool}: ${item.result}`)
    ].join("\n");
  }

  buildFileAssistantDoc({ goal, files, reads, trace }) {
    const scripts = this.extractPackageScripts(reads.find((item) => item.path === "package.json")?.content || "{}");
    return [
      "# File Assistant",
      "",
      "## Назначение",
      "",
      "File Assistant выполняет реальные операции с файлами проекта через MCP: ищет по нескольким файлам, читает найденные источники, анализирует содержимое и сохраняет результат в новый или существующий файл.",
      "",
      `Последняя цель обновления: ${goal}`,
      "",
      "## Основные сценарии",
      "",
      "- Найти все места, где используется компонент, класс, API или команда.",
      "- Обновить документацию по текущему коду проекта.",
      "- Сгенерировать ADR или snapshot проекта.",
      "- Подготовить diff после сохранения результата.",
      "",
      "## MCP-инструменты",
      "",
      "- `list_project_files` — получает список текстовых файлов проекта.",
      "- `read_project_file` — читает выбранный файл проекта.",
      "- `search_project_files` — ищет строку или идентификатор по файлам.",
      "- `summarize_text` — делает краткую сводку по найденным совпадениям.",
      "- `save_to_file` — сохраняет отчет или документацию.",
      "",
      "## Команды запуска",
      "",
      ...scripts
        .filter(([name]) => name.includes("file-assistant"))
        .map(([name, value]) => `- \`npm run ${name}\` — \`${value}\``),
      "",
      "## Прочитанный контекст",
      "",
      ...reads.map((item) => `- ${item.path}: ${item.chars} символов`),
      "",
      "## Структура проекта",
      "",
      ...files.slice(0, 80).map((file) => `- ${file}`),
      "",
      "## Trace Последнего Обновления",
      "",
      ...trace.map((item) => `${item.step}. ${item.tool}: ${item.result}`)
    ].join("\n");
  }

  buildAdr({ goal, files, readme, trace }) {
    return [
      "# ADR: File Assistant For Project Files",
      "",
      "## Context",
      "",
      `Goal: ${goal}`,
      "",
      "The project already contains MCP servers and agents for Git, RAG, support, PR review and orchestration. The file assistant extends this pattern with explicit read/search/write operations over project files.",
      "",
      "## Decision",
      "",
      "Use an MCP-backed CLI agent that can list files, read relevant sources, search across the project and save generated artifacts.",
      "",
      "## Consequences",
      "",
      "- File operations are reproducible from a single high-level goal.",
      "- Reports are saved under `file-assistant-output/` unless the goal updates documentation.",
      "- The assistant can show the trace of tool calls and resulting diff.",
      "",
      "## Evidence",
      "",
      `README chars read: ${readme.chars}`,
      `Project files observed: ${files.length}`,
      "",
      "## Trace",
      "",
      ...trace.map((item) => `${item.step}. ${item.tool}: ${item.result}`)
    ].join("\n");
  }

  buildSnapshot({ goal, files, packageJson, readme, trace }) {
    return [
      "# Project Snapshot",
      "",
      `Goal: ${goal}`,
      "",
      "## Files",
      "",
      ...files.slice(0, 100).map((file) => `- ${file}`),
      "",
      "## package.json",
      "",
      "```json",
      this.truncate(packageJson.content, 3000),
      "```",
      "",
      "## README Excerpt",
      "",
      "```md",
      this.truncate(readme.content, 3000),
      "```",
      "",
      "## Trace",
      "",
      ...trace.map((item) => `${item.step}. ${item.tool}: ${item.result}`)
    ].join("\n");
  }

  extractQuery(goal) {
    const patterns = [
      /(?:найди|найти|ищи)\s+использован(?:ия|ие)?\s+["«]?([A-Za-zА-Яа-яЁё0-9_./:-]+)["»]?/i,
      /(?:где\s+используется)\s+["«]?([A-Za-zА-Яа-яЁё0-9_./:-]+)["»]?/i,
      /(?:используется|использования|usage|найди|найти|ищи)\s+["«]?([A-Za-zА-Яа-яЁё0-9_./:-]+)["»]?/i,
      /(?:компонент|api|класс|функц(?:ия|ию)|команд[ау])\s+["«]?([A-Za-zА-Яа-яЁё0-9_./:-]+)["»]?/i
    ];

    for (const pattern of patterns) {
      const match = goal.match(pattern);
      if (match?.[1]) {
        return match[1].replace(/[.,!?;:]+$/g, "");
      }
    }

    return "GigaChatAgent";
  }

  extractPackageScripts(content) {
    try {
      const packageJson = JSON.parse(content);
      return Object.entries(packageJson.scripts || {});
    } catch {
      return [];
    }
  }

  relativeProjectPath(path) {
    return path.replace(`${this.cwd}/`, "").replace(/^\.\//, "");
  }

  slug(value) {
    return value
      .toLowerCase()
      .replace(/[^a-zа-яё0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "query";
  }

  truncate(value, maxChars) {
    return value.length > maxChars ? `${value.slice(0, maxChars)}\n...` : value;
  }
}

async function runGoal(goal) {
  const assistant = new ProjectFileAssistant({ cwd: "." });
  await assistant.connect();

  try {
    console.log(await assistant.run(goal));
  } finally {
    await assistant.close();
  }
}

const args = parseArgs(process.argv);

if (args.goal) {
  await runGoal(args.goal);
} else {
  const cli = createInterface({ input, output });
  console.log("File Assistant запущен.");
  console.log("Введите цель, например: найди использования GigaChatAgent");
  console.log("Другой пример: обнови документацию по файловому ассистенту");
  console.log("Команда: /exit");
  output.write("\nЦель: ");

  for await (const line of cli) {
    const goal = line.trim();

    if (goal === "/exit") {
      break;
    }

    if (goal) {
      await runGoal(goal);
    }

    output.write("\nЦель: ");
  }

  cli.close();
}
