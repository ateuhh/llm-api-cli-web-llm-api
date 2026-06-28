import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

class McpServerConnection {
  constructor({ id, command, args }) {
    this.id = id;
    this.transport = new StdioClientTransport({
      command,
      args,
      stderr: "pipe"
    });
    this.client = new Client({
      name: `llm-api-cli-${id}-orchestrator-client`,
      version: "1.0.0"
    });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async close() {
    await this.transport.close();
  }

  async listTools() {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => ({
      ...tool,
      serverId: this.id
    }));
  }

  async callJsonTool(name, args = {}) {
    const result = await this.client.callTool({
      name,
      arguments: args
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    return JSON.parse(text);
  }
}

class McpOrchestratorAgent {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.servers = [
      new McpServerConnection({
        id: "git-server",
        command: "node",
        args: ["mcp-git-server.js"]
      }),
      new McpServerConnection({
        id: "files-server",
        command: "node",
        args: ["mcp-files-server.js"]
      })
    ];
    this.toolRegistry = new Map();
  }

  async connect() {
    for (const server of this.servers) {
      await server.connect();
      const tools = await server.listTools();
      for (const tool of tools) {
        this.toolRegistry.set(tool.name, {
          server,
          description: tool.description
        });
      }
    }
  }

  async close() {
    await Promise.all(this.servers.map((server) => server.close()));
  }

  describeRegistry() {
    return [...this.toolRegistry.entries()]
      .map(([tool, entry]) => `${tool} -> ${entry.server.id}`)
      .join("\n");
  }

  selectTool(name) {
    const entry = this.toolRegistry.get(name);

    if (!entry) {
      throw new Error(`MCP-инструмент "${name}" не найден ни на одном сервере.`);
    }

    return entry;
  }

  createTrace() {
    return [];
  }

  async callTool(trace, name, args = {}, reason = "") {
    const { server } = this.selectTool(name);
    const startedAt = new Date().toISOString();
    const result = await server.callJsonTool(name, args);
    trace.push({
      step: trace.length + 1,
      server: server.id,
      tool: name,
      reason,
      args,
      startedAt,
      result: this.compactResult(name, result)
    });
    return result;
  }

  compactResult(tool, result) {
    if (tool === "git_status") {
      return result.summary;
    }
    if (tool === "search_project_files") {
      return `найдено совпадений: ${result.total}`;
    }
    if (tool === "summarize_text") {
      return `обработано строк: ${result.sourceMatches}`;
    }
    if (tool === "save_to_file") {
      return `сохранено: ${result.path}, байт: ${result.bytes}`;
    }
    return JSON.stringify(result);
  }

  buildPlan(userRequest) {
    const normalized = userRequest.toLowerCase();
    const wantsGitStatus = /статус|git|репозитор|изменени|status/.test(normalized);
    const wantsSearch = /найди|поиск|search|найти|найден|ищи|про |о /.test(normalized);
    const wantsSummary = /summary|сводк|резюм|обзор|кратк|отчет|отчёт/.test(normalized);
    const wantsSave = /сохрани|сохранить|save|файл|file|запиши/.test(normalized);
    const outputPath = this.extractOutputPath(userRequest);
    const query = this.extractSearchQuery(userRequest);
    const plan = [];

    if (wantsGitStatus || wantsSave) {
      plan.push({
        tool: "git_status",
        args: { cwd: this.cwd, includeUntracked: true },
        reason: wantsSave
          ? "перед сохранением нужно зафиксировать исходное состояние репозитория"
          : "пользователь запросил состояние Git-репозитория"
      });
    }

    if (wantsSearch || wantsSummary || wantsSave) {
      plan.push({
        tool: "search_project_files",
        args: { query, cwd: this.cwd, maxResults: 20 },
        reason: `нужно получить данные из файлов проекта по запросу "${query}"`
      });
    }

    if (wantsSummary || wantsSave) {
      plan.push({
        tool: "summarize_text",
        args: {
          title: `Orchestration summary for "${query}"`,
          query,
          matchesJson: "$search_project_files",
          maxLines: 8
        },
        reason: "нужно обработать найденные данные и сделать сводку"
      });
    }

    if (wantsSave) {
      plan.push({
        tool: "save_to_file",
        args: {
          path: outputPath,
          content: "$summarize_text.summary",
          append: false
        },
        reason: "пользователь попросил сохранить результат в файл"
      });
      plan.push({
        tool: "git_status",
        args: { cwd: this.cwd, includeUntracked: true },
        reason: "после сохранения нужно проверить, что файл появился в состоянии Git"
      });
    }

    if (plan.length === 0) {
      plan.push({
        tool: "git_status",
        args: { cwd: this.cwd, includeUntracked: true },
        reason: "запрос не содержит явного действия, поэтому показываю безопасный статус репозитория"
      });
    }

    return {
      userRequest,
      query,
      outputPath,
      plan
    };
  }

  extractSearchQuery(userRequest) {
    const patterns = [
      /(?:найди|найти|ищи|поиск|search)\s+["“]?([^"”]+?)["”]?(?:\s+и|\s+в\s+проекте|\s+по\s+проекту|\s*$)/i,
      /(?:по запросу|на тему|про|о)\s+["“]?([^"”]+?)["”]?(?:\s+и|\s+сохрани|\s*$)/i
    ];

    for (const pattern of patterns) {
      const match = userRequest.match(pattern);
      if (match?.[1]) {
        return this.cleanupExtractedText(match[1]);
      }
    }

    const withoutPath = userRequest.replace(/\S+\.md\b/g, "");
    const keywords = withoutPath
      .split(/\s+/)
      .map((word) => word.replace(/[.,:;!?()"'«»]/g, ""))
      .filter((word) => word.length > 3)
      .filter((word) => ![
        "найди",
        "найти",
        "сделай",
        "сводку",
        "сводка",
        "сохрани",
        "сохранить",
        "файл",
        "проекте",
        "статус",
        "репозитория"
      ].includes(word.toLowerCase()));

    return keywords[0] || "MCP";
  }

  cleanupExtractedText(value) {
    return value
      .replace(/[,;:]\s*(сделай|сформируй|подготовь)\s+(сводку|summary|отчет|отчёт).*$/i, "")
      .replace(/\s+(и|сохрани|сохранить|запиши|в файл).*$/i, "")
      .trim()
      .replace(/[.,:;!?]+$/g, "") || "MCP";
  }

  extractOutputPath(userRequest) {
    const pathMatch = userRequest.match(/(?:в файл|файл|to|в)\s+([./\w-]+\.md)\b/i);
    return pathMatch?.[1] || "./orchestration-summary.md";
  }

  resolveArgs(args, context) {
    const resolved = {};

    for (const [key, value] of Object.entries(args)) {
      if (value === "$search_project_files") {
        resolved[key] = JSON.stringify(context.search_project_files);
      } else if (value === "$summarize_text.summary") {
        resolved[key] = context.summarize_text.summary;
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  async executeRequest(userRequest) {
    const planned = this.buildPlan(userRequest);
    const context = {};
    const trace = this.createTrace();

    for (const step of planned.plan) {
      const args = this.resolveArgs(step.args, context);
      context[step.tool] = await this.callTool(trace, step.tool, args, step.reason);
    }

    return {
      ...planned,
      context,
      trace,
      finalAnswer: this.buildFinalAnswer(planned, context, trace)
    };
  }

  buildFinalAnswer(planned, context, trace) {
    const lines = [
      "Запрос обработан оркестратором.",
      `Шагов выполнено: ${trace.length}.`
    ];

    if (context.search_project_files) {
      lines.push(`Поиск по "${planned.query}": ${context.search_project_files.total} совпадений.`);
    }
    if (context.summarize_text) {
      lines.push(`Сводка построена: ${context.summarize_text.sourceMatches} строк источника.`);
    }
    if (context.save_to_file) {
      lines.push(`Результат сохранен: ${context.save_to_file.path}.`);
    }
    if (context.git_status) {
      lines.push(`Текущий Git: ${context.git_status.summary}`);
    }

    return lines.join("\n");
  }
}

function printPlan(result) {
  console.log("План выполнения:");
  for (const [index, step] of result.plan.entries()) {
    console.log(`${index + 1}. ${step.tool} — ${step.reason}`);
  }
}

function printTrace(result) {
  console.log("Порядок отработанных задач:");
  for (const step of result.trace) {
    console.log(`${step.step}. ${step.server} -> ${step.tool}`);
    console.log(`   причина: ${step.reason}`);
    console.log(`   результат: ${step.result}`);
  }
}

function printHelp() {
  console.log("Введите обычный запрос, например:");
  console.log('- "Покажи статус репозитория"');
  console.log('- "Найди MCP и сделай сводку"');
  console.log('- "Найди agent, сделай сводку и сохрани в файл ./agent-report.md"');
  console.log("Команды: /tools, /exit");
}

async function runOnce(agent, request) {
  const result = await agent.executeRequest(request);
  printPlan(result);
  console.log("");
  printTrace(result);
  console.log("");
  console.log("Итог:");
  console.log(result.finalAnswer);
}

const args = process.argv.slice(2);
const agent = new McpOrchestratorAgent();

try {
  await agent.connect();
  console.log("Orchestrator подключился к нескольким MCP-серверам.");
  console.log("");
  console.log("Реестр инструментов:");
  console.log(agent.describeRegistry());
  console.log("");

  if (args.length > 0) {
    await runOnce(agent, args.join(" "));
  } else {
    printHelp();
    const cli = createInterface({ input, output });
    output.write("\nВы: ");

    for await (const line of cli) {
      const request = line.trim();

      try {
        if (request === "/exit") {
          break;
        } else if (request === "/tools") {
          console.log(agent.describeRegistry());
        } else if (request) {
          await runOnce(agent, request);
        }
      } catch (error) {
        console.error(`Ошибка: ${error.message}`);
      }

      output.write("\nВы: ");
    }

    cli.close();
  }
} finally {
  await agent.close();
}
