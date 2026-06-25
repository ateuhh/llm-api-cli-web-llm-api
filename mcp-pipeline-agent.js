import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class McpPipelineAgent {
  constructor({
    query = "MCP",
    cwd = ".",
    outputPath = "./mcp-output/pipeline-summary.md"
  } = {}) {
    this.query = query;
    this.cwd = cwd;
    this.outputPath = outputPath;
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["mcp-server.js"],
      stderr: "pipe"
    });
    this.client = new Client({
      name: "llm-api-cli-mcp-pipeline-agent",
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
      arguments: args
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    return JSON.parse(text);
  }

  async assertToolsAvailable() {
    const requiredTools = ["search_project_files", "summarize_text", "save_to_file"];
    const { tools } = await this.client.listTools();
    const availableTools = new Set(tools.map((tool) => tool.name));
    const missingTools = requiredTools.filter((tool) => !availableTools.has(tool));

    if (missingTools.length > 0) {
      throw new Error(`Нет MCP-инструментов: ${missingTools.join(", ")}`);
    }
  }

  async run() {
    await this.assertToolsAvailable();

    const searchResult = await this.callJsonTool("search_project_files", {
      query: this.query,
      cwd: this.cwd,
      maxResults: 20
    });
    const summarizeResult = await this.callJsonTool("summarize_text", {
      title: `Сводка по запросу "${this.query}"`,
      query: this.query,
      matchesJson: JSON.stringify(searchResult),
      maxLines: 8
    });
    const saveResult = await this.callJsonTool("save_to_file", {
      path: this.outputPath,
      content: summarizeResult.summary,
      append: false
    });

    return {
      searchResult,
      summarizeResult,
      saveResult
    };
  }
}

const [query = "MCP", outputPath = "./mcp-output/pipeline-summary.md"] = process.argv.slice(2);
const agent = new McpPipelineAgent({ query, outputPath });

try {
  await agent.connect();
  console.log("MCP-соединение установлено.");
  const { searchResult, summarizeResult, saveResult } = await agent.run();

  console.log("Pipeline выполнен автоматически:");
  console.log(`1. search_project_files -> найдено совпадений: ${searchResult.total}`);
  console.log(`2. summarize_text -> строк источника: ${summarizeResult.sourceMatches}`);
  console.log(`3. save_to_file -> файл: ${saveResult.path}, байт: ${saveResult.bytes}`);
  console.log("");
  console.log("Итоговая сводка:");
  console.log(summarizeResult.summary);
} finally {
  await agent.close();
}
