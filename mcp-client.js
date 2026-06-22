import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["mcp-server.js"],
  stderr: "pipe"
});

const client = new Client({
  name: "llm-api-cli-mcp-client",
  version: "1.0.0"
});

try {
  await client.connect(transport);
  console.log("MCP-соединение установлено.");

  const { tools } = await client.listTools();
  console.log(`Найдено инструментов: ${tools.length}`);

  for (const tool of tools) {
    console.log(`- ${tool.name}: ${tool.description || "без описания"}`);
  }
} finally {
  await transport.close();
}
