import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const server = new McpServer({
  name: "llm-api-cli-git-mcp-server",
  version: "1.0.0"
});

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function jsonTextResult(value) {
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
    const changedFiles = status
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return jsonTextResult({
      cwd,
      branch: branch || "(detached)",
      clean: changedFiles.length === 0,
      changedFiles,
      summary: changedFiles.length === 0
        ? `Ветка ${branch || "(detached)"}: рабочее дерево чистое.`
        : `Ветка ${branch || "(detached)"}: изменений ${changedFiles.length}. ${changedFiles.join(", ")}`
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
