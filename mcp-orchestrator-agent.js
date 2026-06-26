import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  constructor({
    query = "MCP",
    cwd = ".",
    outputPath = "./orchestration-summary.md"
  } = {}) {
    this.query = query;
    this.cwd = cwd;
    this.outputPath = outputPath;
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
    this.trace = [];
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

  selectTool(name) {
    const entry = this.toolRegistry.get(name);

    if (!entry) {
      throw new Error(`MCP-инструмент "${name}" не найден ни на одном сервере.`);
    }

    return entry;
  }

  async callTool(name, args = {}) {
    const { server } = this.selectTool(name);
    this.trace.push({
      step: this.trace.length + 1,
      server: server.id,
      tool: name,
      args
    });
    return server.callJsonTool(name, args);
  }

  async run() {
    const beforeStatus = await this.callTool("git_status", {
      cwd: this.cwd,
      includeUntracked: true
    });
    const searchResult = await this.callTool("search_project_files", {
      query: this.query,
      cwd: this.cwd,
      maxResults: 20
    });
    const summaryResult = await this.callTool("summarize_text", {
      title: `Orchestration summary for "${this.query}"`,
      query: this.query,
      matchesJson: JSON.stringify(searchResult),
      maxLines: 8
    });
    const report = [
      summaryResult.summary,
      "",
      "## Git status before saving",
      beforeStatus.summary
    ].join("\n");
    const saveResult = await this.callTool("save_to_file", {
      path: this.outputPath,
      content: report,
      append: false
    });
    const afterStatus = await this.callTool("git_status", {
      cwd: this.cwd,
      includeUntracked: true
    });

    return {
      beforeStatus,
      searchResult,
      summaryResult,
      saveResult,
      afterStatus,
      trace: this.trace
    };
  }

  describeRegistry() {
    return [...this.toolRegistry.entries()]
      .map(([tool, entry]) => `${tool} -> ${entry.server.id}`)
      .join("\n");
  }
}

const [
  query = "MCP",
  outputPath = "./orchestration-summary.md"
] = process.argv.slice(2);
const agent = new McpOrchestratorAgent({ query, outputPath });

try {
  await agent.connect();
  console.log("Orchestrator подключился к нескольким MCP-серверам.");
  console.log("");
  console.log("Реестр инструментов:");
  console.log(agent.describeRegistry());
  console.log("");

  const result = await agent.run();

  console.log("Длинный flow выполнен:");
  for (const step of result.trace) {
    console.log(`${step.step}. ${step.server} -> ${step.tool}`);
  }
  console.log("");
  console.log(`До сохранения: ${result.beforeStatus.summary}`);
  console.log(`Поиск: найдено совпадений ${result.searchResult.total}`);
  console.log(`Summary: обработано строк ${result.summaryResult.sourceMatches}`);
  console.log(`Сохранение: ${result.saveResult.path}, байт ${result.saveResult.bytes}`);
  console.log(`После сохранения: ${result.afterStatus.summary}`);
} finally {
  await agent.close();
}
