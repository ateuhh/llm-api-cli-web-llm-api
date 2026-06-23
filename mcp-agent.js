import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class McpGitAgent {
  constructor({ cwd = ".", includeUntracked = true } = {}) {
    this.cwd = cwd;
    this.includeUntracked = includeUntracked;
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["mcp-server.js"],
      stderr: "pipe"
    });
    this.client = new Client({
      name: "llm-api-cli-mcp-agent",
      version: "1.0.0"
    });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async close() {
    await this.transport.close();
  }

  async answer() {
    const { tools } = await this.client.listTools();
    const hasGitStatus = tools.some((tool) => tool.name === "git_status");

    if (!hasGitStatus) {
      throw new Error("MCP-инструмент git_status недоступен.");
    }

    const toolResult = await this.client.callTool({
      name: "git_status",
      arguments: {
        cwd: this.cwd,
        includeUntracked: this.includeUntracked
      }
    });
    const textResult = toolResult.content.find((item) => item.type === "text")?.text;
    const gitStatus = JSON.parse(textResult);

    return [
      "Агент вызвал MCP-инструмент git_status.",
      `Репозиторий: ${gitStatus.cwd}`,
      `Ветка: ${gitStatus.branch}`,
      gitStatus.clean
        ? "Рабочее дерево чистое."
        : `Есть изменения: ${gitStatus.changedFiles.join(", ")}`
    ].join("\n");
  }
}

const agent = new McpGitAgent({
  cwd: process.argv[2] || ".",
  includeUntracked: !process.argv.includes("--no-untracked")
});

try {
  await agent.connect();
  console.log("MCP-соединение установлено.");
  console.log(await agent.answer());
} finally {
  await agent.close();
}
