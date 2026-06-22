import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "llm-api-cli-local-mcp-server",
  version: "1.0.0"
});

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

const transport = new StdioServerTransport();
await server.connect(transport);
