import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { GigaChatAgent } from "./agent.js";

const DEFAULT_DOC_FILES = ["README.md"];
const DOCS_DIR = "project/docs";
const MAX_CONTEXT_CHUNKS = Number(process.env.DEV_ASSISTANT_TOP_K || 5);

const STOP_WORDS = new Set([
  "что",
  "как",
  "для",
  "или",
  "это",
  "если",
  "при",
  "над",
  "под",
  "какие",
  "какая",
  "какой",
  "the",
  "and",
  "with",
  "from",
  "this",
  "that"
]);

class ProjectDocsRag {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.chunks = [];
  }

  async build() {
    const files = [...DEFAULT_DOC_FILES, ...(await this.resolveDocsFiles())];
    const chunks = [];

    for (const file of files) {
      const content = await readFile(join(this.cwd, file), "utf8");
      chunks.push(...this.chunkFile(file, content));
    }

    this.chunks = chunks.map((chunk, index) => ({
      ...chunk,
      id: `doc-${String(index + 1).padStart(4, "0")}`,
      tokens: this.tokenize(chunk.text)
    }));
    return this.chunks;
  }

  async resolveDocsFiles() {
    try {
      const entries = await readdir(join(this.cwd, DOCS_DIR), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
        .map((entry) => join(DOCS_DIR, entry.name));
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  chunkFile(source, content) {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const chunks = [];
    let section = "file";
    let buffer = [];
    let startLine = 1;

    const flush = (endLine) => {
      const text = buffer.join("\n").trim();
      if (!text) {
        return;
      }
      chunks.push({ source, section, lineStart: startLine, lineEnd: endLine, text });
    };

    for (const [index, line] of lines.entries()) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading && buffer.length > 0) {
        flush(index);
        buffer = [];
        startLine = index + 1;
      }
      if (heading) {
        section = heading[2].trim();
      }
      buffer.push(line);

      if (buffer.join("\n").length > 1800) {
        flush(index + 1);
        buffer = [];
        startLine = index + 2;
      }
    }

    flush(lines.length);
    return chunks;
  }

  search(question, topK = MAX_CONTEXT_CHUNKS) {
    const queryTokens = new Set(this.expandQueryTokens(question));

    return this.chunks
      .map((chunk) => {
        const uniqueTokens = [...new Set(chunk.tokens)];
        const overlap = uniqueTokens.filter((token) => queryTokens.has(token)).length;
        const docsBoost = chunk.source.startsWith(DOCS_DIR) ? 0.18 : 0;
        const architectureBoost = /структур|архитектур|файл|папк/.test(question.toLowerCase()) &&
          chunk.source.endsWith("architecture.md")
          ? 0.35
          : 0;
        const apiBoost = /api|endpoint|команд|mcp/.test(question.toLowerCase()) &&
          chunk.source.endsWith("api.md")
          ? 0.25
          : 0;
        const privateAiBoost = /приват|private|сервис|братск/.test(question.toLowerCase()) &&
          (/private-ai|Приватный AI-сервис|Локальная LLM как приватный сервис/.test(chunk.text) ||
            /api\.md$/.test(chunk.source))
          ? 0.3
          : 0;
        const score = (queryTokens.size === 0 ? 0 : overlap / queryTokens.size) +
          docsBoost +
          architectureBoost +
          apiBoost +
          privateAiBoost;
        return { ...chunk, score };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  expandQueryTokens(question) {
    const normalized = question.toLowerCase();
    const extra = [];
    const add = (...tokens) => extra.push(...tokens);

    if (/структур|файл|папк|где|запуск/.test(normalized)) {
      add("структура", "package.json", "npm", "run", "README", "private-ai", "local-rag", "mcp");
    }
    if (/mcp|ветк|git|branch|статус/.test(normalized)) {
      add("MCP", "git_status", "branch", "changedFiles", "mcp-server");
    }
    if (/rag|документ|индекс|docs|readme/.test(normalized)) {
      add("RAG", "README", "project/docs", "document-index", "local-rag");
    }
    if (/локальн|ollama|llm|модель/.test(normalized)) {
      add("Ollama", "llama3.2:1b", "local-llm", "private-ai");
    }

    return [...new Set([...this.tokenize(question), ...extra.flatMap((item) => this.tokenize(item))])];
  }

  tokenize(text) {
    return String(text)
      .toLowerCase()
      .match(/[a-zа-яё0-9_/-]{3,}/gi)
      ?.map((token) => token.toLowerCase())
      .filter((token) => !STOP_WORDS.has(token)) || [];
  }

  formatContext(chunks) {
    return chunks
      .map((chunk, index) =>
        [
          `[Источник ${index + 1}: ${chunk.source}; section=${chunk.section}; lines=${chunk.lineStart}-${chunk.lineEnd}; chunk_id=${chunk.id}]`,
          chunk.text
        ].join("\n")
      )
      .join("\n\n");
  }
}

class ProjectMcpContext {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["mcp-server.js"],
      stderr: "pipe"
    });
    this.client = new Client({
      name: "developer-assistant-mcp-client",
      version: "1.0.0"
    });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async close() {
    await this.transport.close();
  }

  async gitStatus() {
    const result = await this.client.callTool({
      name: "git_status",
      arguments: {
        cwd: this.cwd,
        includeUntracked: true
      }
    });
    const text = result.content.find((item) => item.type === "text")?.text || "{}";
    return JSON.parse(text);
  }
}

class DeveloperAssistant {
  constructor({
    cwd = ".",
    mock = false,
    authKey = process.env.GIGACHAT_AUTH_KEY,
    model = process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
  } = {}) {
    this.cwd = cwd;
    this.mock = mock;
    this.rag = new ProjectDocsRag({ cwd });
    this.mcp = new ProjectMcpContext({ cwd });
    this.llm = new GigaChatAgent({
      authKey,
      model,
      scope,
      compressionEnabled: false,
      historyPath: `/tmp/developer-assistant-${crypto.randomUUID()}.json`,
      systemPrompt: "Ты аккуратный ассистент разработчика. Не выдумывай файлы, команды и ветки."
    });
  }

  async init() {
    await this.rag.build();
    await this.mcp.connect();
  }

  async close() {
    await this.mcp.close();
  }

  async help(question) {
    const chunks = this.rag.search(question);
    const gitStatus = await this.mcp.gitStatus();
    const context = this.rag.formatContext(chunks);

    if (this.mock) {
      return this.mockAnswer(question, chunks, gitStatus);
    }

    const prompt = [
      "Ты ассистент разработчика внутри проекта.",
      "Отвечай по-русски, кратко и практично.",
      "Используй только документацию и MCP-контекст ниже.",
      "Если информации не хватает, скажи, где в проекте смотреть дальше.",
      "Обязательно укажи текущую git-ветку и источники.",
      "Не создавай URL и markdown-ссылки: указывай только локальные пути файлов.",
      "",
      `Вопрос: ${question}`,
      "",
      "MCP-контекст:",
      `Текущая git-ветка: ${gitStatus.branch}`,
      `Измененные файлы: ${gitStatus.changedFiles.length ? gitStatus.changedFiles.join(", ") : "нет"}`,
      "",
      "RAG-контекст:",
      context || "Релевантные фрагменты документации не найдены."
    ].join("\n");

    try {
      const answer = this.sanitizeAnswer(await this.callGigaChat(prompt));
      return this.ensureSources(answer, chunks, gitStatus);
    } catch (error) {
      return [
        `GigaChat API недоступен: ${error.message}`,
        "",
        this.mockAnswer(question, chunks, gitStatus)
      ].join("\n");
    }
  }

  async callGigaChat(prompt) {
    const completion = await this.llm.requestCompletion(
      [
        {
          role: "system",
          content: [
            "Ты ассистент разработчика внутри проекта.",
            "Отвечай только по переданным README, project/docs и MCP-контексту.",
            "Не создавай URL и markdown-ссылки.",
            "Если данных не хватает, так и скажи."
          ].join(" ")
        },
        { role: "user", content: prompt }
      ],
      700
    );

    return completion.answer;
  }

  ensureSources(answer, chunks, gitStatus) {
    if (/Источники:/i.test(answer) && /git-ветк|ветк/i.test(answer)) {
      return answer;
    }

    return [
      answer,
      "",
      `MCP: текущая git-ветка — ${gitStatus.branch}.`,
      "Источники:",
      ...chunks.map((chunk) => `- ${chunk.source}; section=${chunk.section}; chunk_id=${chunk.id}`)
    ].join("\n");
  }

  sanitizeAnswer(answer) {
    return answer
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .trim();
  }

  mockAnswer(question, chunks, gitStatus) {
    const useful = chunks
      .flatMap((chunk) => chunk.text.split("\n").map((line) => line.trim()))
      .filter((line) => line.length > 8)
      .slice(0, 8);

    return [
      `MCP: текущая git-ветка — ${gitStatus.branch}.`,
      "",
      `Ответ на вопрос: ${question}`,
      useful.length
        ? useful.map((line) => `- ${line.replace(/^[-*]\s*/, "")}`).join("\n")
        : "- В документации не нашлось прямого ответа. Начните с README.md и project/docs.",
      "",
      "Источники:",
      ...chunks.map((chunk) => `- ${chunk.source}; section=${chunk.section}; chunk_id=${chunk.id}`)
    ].join("\n");
  }
}

const useMock = process.argv.includes("--mock");
const assistant = new DeveloperAssistant({ cwd: ".", mock: useMock });
await assistant.init();

const cli = createInterface({ input, output });
console.log(`Developer Assistant запущен${useMock ? " в mock-режиме" : ""}.`);
console.log(`RAG-документов: ${new Set(assistant.rag.chunks.map((chunk) => chunk.source)).size}; чанков: ${assistant.rag.chunks.length}.`);
console.log("Команды: /help вопрос, /branch, /sources, /exit");
output.write("\nВы: ");

for await (const line of cli) {
  const text = line.trim();

  if (!text) {
    output.write("\nВы: ");
    continue;
  }

  if (text === "/exit") {
    break;
  }

  if (text === "/branch") {
    const gitStatus = await assistant.mcp.gitStatus();
    console.log(`MCP git_status: ветка ${gitStatus.branch}; изменений ${gitStatus.changedFiles.length}.`);
    output.write("\nВы: ");
    continue;
  }

  if (text === "/sources") {
    const sources = [...new Set(assistant.rag.chunks.map((chunk) => chunk.source))];
    console.log(sources.map((source) => `- ${relative(".", source)}`).join("\n"));
    output.write("\nВы: ");
    continue;
  }

  if (text.startsWith("/help")) {
    const question = text.replace(/^\/help\s*/, "").trim() || "Расскажи о структуре проекта.";
    console.log("\nАссистент:");
    console.log(await assistant.help(question));
    output.write("\nВы: ");
    continue;
  }

  console.log('Используйте формат: /help ваш вопрос. Например: /help как устроен приватный AI-сервис?');
  output.write("\nВы: ");
}

cli.close();
await assistant.close();
console.log("Developer Assistant завершен.");
