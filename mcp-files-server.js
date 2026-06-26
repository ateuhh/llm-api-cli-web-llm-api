import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const server = new McpServer({
  name: "llm-api-cli-files-mcp-server",
  version: "1.0.0"
});

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

async function collectSearchFiles(directory, result = []) {
  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "certs",
    ".agents",
    ".codex",
    "mcp-output"
  ]);
  const allowedExtensions = /\.(js|json|md|txt)$/i;
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await collectSearchFiles(path, result);
      }
      continue;
    }

    if (entry.isFile() && allowedExtensions.test(entry.name)) {
      result.push(path);
    }
  }

  return result;
}

function summarizeMatches({ title, query, matches, maxLines }) {
  const files = [...new Set(matches.map((match) => match.file))];
  const lines = [
    `# ${title}`,
    "",
    `Запрос: ${query}`,
    `Найдено совпадений: ${matches.length}`,
    `Файлов: ${files.length}`,
    ""
  ];

  for (const file of files.slice(0, maxLines)) {
    const fileMatches = matches.filter((match) => match.file === file);
    lines.push(`- ${file}: ${fileMatches.length} совпадений`);
    for (const match of fileMatches.slice(0, 2)) {
      lines.push(`  - строка ${match.line}: ${match.text}`);
    }
  }

  if (files.length > maxLines) {
    lines.push(`- Еще файлов: ${files.length - maxLines}`);
  }

  return lines.join("\n");
}

server.registerTool(
  "search_project_files",
  {
    description: "Ищет текст в файлах проекта и возвращает найденные строки.",
    inputSchema: {
      query: z.string().min(1).describe("Текст для поиска."),
      cwd: z.string().default(".").describe("Папка проекта."),
      maxResults: z.number().int().positive().default(20).describe("Максимум совпадений.")
    }
  },
  async ({ query, cwd, maxResults }) => {
    const files = await collectSearchFiles(cwd);
    const normalizedQuery = query.toLowerCase();
    const matches = [];

    for (const file of files) {
      if (matches.length >= maxResults) {
        break;
      }

      const content = await readFile(file, "utf8");
      const lines = content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.toLowerCase().includes(normalizedQuery)) {
          matches.push({
            file,
            line: index + 1,
            text: line.trim().slice(0, 240)
          });
        }
        if (matches.length >= maxResults) {
          break;
        }
      }
    }

    return jsonTextResult({
      query,
      cwd,
      total: matches.length,
      matches,
      combinedText: matches
        .map((match) => `${match.file}:${match.line} ${match.text}`)
        .join("\n")
    });
  }
);

server.registerTool(
  "summarize_text",
  {
    description: "Делает краткую сводку по найденным данным.",
    inputSchema: {
      title: z.string().default("MCP orchestration summary").describe("Заголовок сводки."),
      query: z.string().min(1).describe("Исходный поисковый запрос."),
      matchesJson: z.string().min(1).describe("JSON-результат инструмента search_project_files."),
      maxLines: z.number().int().positive().default(8).describe("Сколько файлов включить в summary.")
    }
  },
  async ({ title, query, matchesJson, maxLines }) => {
    const searchResult = JSON.parse(matchesJson);
    const matches = Array.isArray(searchResult.matches) ? searchResult.matches : [];

    return jsonTextResult({
      title,
      query,
      sourceMatches: matches.length,
      summary: summarizeMatches({
        title,
        query,
        matches,
        maxLines
      })
    });
  }
);

server.registerTool(
  "save_to_file",
  {
    description: "Сохраняет текстовый результат в файл.",
    inputSchema: {
      path: z.string().min(1).describe("Путь к файлу для сохранения."),
      content: z.string().describe("Текст, который нужно сохранить."),
      append: z.boolean().default(false).describe("Добавлять в конец файла вместо перезаписи.")
    }
  },
  async ({ path, content, append }) => {
    const existingContent = append
      ? await readFile(path, "utf8").catch((error) => {
          if (error.code === "ENOENT") {
            return "";
          }
          throw error;
        })
      : "";
    const savedContent = append && existingContent
      ? `${existingContent.trimEnd()}\n\n${content}\n`
      : `${content}\n`;

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, savedContent, "utf8");
    const fileStat = await stat(path);

    return jsonTextResult({
      path,
      bytes: fileStat.size,
      appended: append,
      savedAt: new Date().toISOString()
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
