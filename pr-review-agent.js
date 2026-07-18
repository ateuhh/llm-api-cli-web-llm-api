import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { GigaChatAgent } from "./agent.js";

const execFileAsync = promisify(execFile);

const DEFAULT_REVIEW_OUTPUT = "ai-code-review.md";
const DEFAULT_TOP_K = Number(process.env.PR_REVIEW_TOP_K || 8);
const MAX_DIFF_CHARS = Number(process.env.PR_REVIEW_MAX_DIFF_CHARS || 18000);
const MAX_CONTEXT_CHARS = Number(process.env.PR_REVIEW_MAX_CONTEXT_CHARS || 14000);

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
  "the",
  "and",
  "with",
  "from",
  "this",
  "that",
  "import",
  "const",
  "return"
]);

function parseArgs(argv) {
  const args = {
    base: process.env.PR_BASE_REF || process.env.GITHUB_BASE_REF || "HEAD~1",
    head: process.env.PR_HEAD_REF || "HEAD",
    output: process.env.PR_REVIEW_OUTPUT || DEFAULT_REVIEW_OUTPUT,
    mock: process.env.PR_REVIEW_MOCK === "1"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--base" && next) {
      args.base = next;
      index += 1;
    } else if (arg === "--head" && next) {
      args.head = next;
      index += 1;
    } else if (arg === "--output" && next) {
      args.output = next;
      index += 1;
    } else if (arg === "--mock") {
      args.mock = true;
    }
  }

  return args;
}

async function git(args, cwd = ".") {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trimEnd();
}

async function safeGit(args, fallback = "") {
  try {
    return await git(args);
  } catch {
    return fallback;
  }
}

function diffRange(base, head) {
  return `${base}...${head}`;
}

async function collectPullRequestContext({ base, head }) {
  const range = diffRange(base, head);
  let diff = await safeGit(["diff", "--unified=80", "--find-renames", range], "");
  let changedFiles = await safeGit(["diff", "--name-only", range], "");

  if (!diff) {
    diff = await safeGit(["diff", "--unified=80", "--find-renames", "HEAD~1", "HEAD"], "");
    changedFiles = await safeGit(["diff", "--name-only", "HEAD~1", "HEAD"], "");
  }

  const branch = await safeGit(["branch", "--show-current"], process.env.GITHUB_HEAD_REF || "(detached)");
  const status = await safeGit(["status", "--short"], "");

  return {
    range,
    branch: branch || process.env.GITHUB_HEAD_REF || "(detached)",
    status,
    changedFiles: changedFiles.split("\n").filter(Boolean),
    diff
  };
}

class ReviewRagIndex {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.chunks = [];
  }

  async build(changedFiles = []) {
    const files = await this.resolveFiles(changedFiles);
    const chunks = [];

    for (const file of files) {
      try {
        const content = await readFile(join(this.cwd, file), "utf8");
        chunks.push(...this.chunkFile(file, content));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EISDIR") {
          throw error;
        }
      }
    }

    this.chunks = chunks.map((chunk, index) => ({
      ...chunk,
      chunkId: `review-${String(index + 1).padStart(4, "0")}`,
      tokens: this.tokenize(chunk.text)
    }));
    return this.chunks;
  }

  async resolveFiles(changedFiles) {
    const docs = ["README.md", ...(await this.resolveProjectDocs())];
    const code = await this.resolveProjectCodeFiles();
    const changedTextFiles = changedFiles.filter((file) => /\.(js|json|md|txt|yml|yaml)$/i.test(file));
    return [...new Set([...docs, ...changedTextFiles, ...code])];
  }

  async resolveProjectDocs() {
    try {
      const entries = await readdir(join(this.cwd, "project/docs"), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
        .map((entry) => `project/docs/${entry.name}`);
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async resolveProjectCodeFiles() {
    const entries = await readdir(this.cwd, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(js|json)$/i.test(entry.name))
      .map((entry) => relative(this.cwd, join(this.cwd, entry.name)))
      .filter((file) => !file.endsWith("package-lock.json"));
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
      const classOrFunction = line.match(/^\s*(?:export\s+)?(?:class|function)\s+([A-Za-z0-9_]+)/);

      if ((heading || classOrFunction) && buffer.length > 0) {
        flush(index);
        buffer = [];
        startLine = index + 1;
      }

      if (heading) {
        section = heading[2].trim();
      } else if (classOrFunction) {
        section = classOrFunction[1];
      }

      buffer.push(line);

      if (buffer.join("\n").length > 2200) {
        flush(index + 1);
        buffer = [];
        startLine = index + 2;
      }
    }

    flush(lines.length);
    return chunks;
  }

  search(query, topK = DEFAULT_TOP_K) {
    const queryTokens = new Set(this.tokenize(query));

    return this.chunks
      .map((chunk) => {
        const uniqueTokens = [...new Set(chunk.tokens)];
        const overlap = uniqueTokens.filter((token) => queryTokens.has(token)).length;
        const docsBoost = /readme|project\/docs/.test(chunk.source) ? 0.2 : 0;
        const changedFileBoost = query.includes(chunk.source) ? 0.35 : 0;
        const reviewBoost = /agent|mcp|rag|review|github|action/i.test(chunk.text) ? 0.08 : 0;
        return {
          ...chunk,
          score: (queryTokens.size === 0 ? 0 : overlap / queryTokens.size) +
            docsBoost +
            changedFileBoost +
            reviewBoost
        };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  tokenize(text) {
    return String(text)
      .toLowerCase()
      .match(/[a-zа-яё0-9_./:-]{3,}/gi)
      ?.map((token) => token.toLowerCase())
      .filter((token) => !STOP_WORDS.has(token)) || [];
  }

  format(chunks) {
    return chunks
      .map((chunk, index) =>
        [
          `[RAG ${index + 1}: ${chunk.source}; section=${chunk.section}; lines=${chunk.lineStart}-${chunk.lineEnd}; chunk_id=${chunk.chunkId}; score=${chunk.score.toFixed(2)}]`,
          chunk.text
        ].join("\n")
      )
      .join("\n\n")
      .slice(0, MAX_CONTEXT_CHARS);
  }
}

class PullRequestReviewAgent {
  constructor({
    mock = false,
    authKey = process.env.GIGACHAT_AUTH_KEY,
    model = process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
  } = {}) {
    this.mock = mock;
    this.llm = new GigaChatAgent({
      authKey,
      model,
      scope,
      compressionEnabled: false,
      historyPath: `/tmp/pr-review-agent-${crypto.randomUUID()}.json`,
      systemPrompt: "Ты строгий, но практичный ревьюер кода."
    });
  }

  async review({ prContext, ragContext, chunks }) {
    if (!prContext.diff.trim()) {
      return this.emptyReview(prContext);
    }

    if (this.mock || !process.env.GIGACHAT_AUTH_KEY) {
      return this.mockReview({ prContext, chunks });
    }

    const prompt = this.buildPrompt({ prContext, ragContext });

    try {
      const completion = await this.llm.requestCompletion(
        [
          {
            role: "system",
            content: [
              "Ты делаешь автоматическое ревью pull request.",
              "Пиши по-русски.",
              "Ищи реальные баги, архитектурные риски, проблемы безопасности и тестовые пробелы.",
              "Не выдумывай файлы и строки. Если доказательств мало, помечай пункт как риск."
            ].join(" ")
          },
          { role: "user", content: prompt }
        ],
        1200
      );
      return this.normalizeReview(completion.answer, prContext, chunks);
    } catch (error) {
      return [
        "## AI Code Review",
        "",
        `GigaChat API недоступен: ${error.message}`,
        "",
        this.mockReview({ prContext, chunks })
      ].join("\n");
    }
  }

  buildPrompt({ prContext, ragContext }) {
    return [
      "Сделай ревью PR по diff ниже.",
      "",
      "Верни строго Markdown со структурами:",
      "1. Потенциальные баги",
      "2. Архитектурные проблемы",
      "3. Рекомендации",
      "4. Использованный контекст",
      "",
      "Для каждого пункта указывай файл, причину и конкретное действие.",
      "Если критичных проблем нет, напиши это явно.",
      "",
      "Git/MCP-контекст:",
      `- Ветка: ${prContext.branch}`,
      `- Диапазон diff: ${prContext.range}`,
      `- Измененные файлы: ${prContext.changedFiles.join(", ") || "нет"}`,
      "",
      "RAG-контекст документации и кода:",
      ragContext || "Релевантный контекст не найден.",
      "",
      "Diff:",
      prContext.diff.slice(0, MAX_DIFF_CHARS)
    ].join("\n");
  }

  normalizeReview(answer, prContext, chunks) {
    const hasTitle = /^##?\s+AI Code Review/im.test(answer);
    const sources = this.formatSources(chunks);
    return [
      hasTitle ? answer.trim() : `## AI Code Review\n\n${answer.trim()}`,
      "",
      "### Pipeline Context",
      `- Branch: ${prContext.branch}`,
      `- Diff range: ${prContext.range}`,
      `- Changed files: ${prContext.changedFiles.join(", ") || "нет"}`,
      "",
      sources
    ].join("\n");
  }

  mockReview({ prContext, chunks }) {
    const findings = this.heuristicFindings(prContext);
    return [
      "## AI Code Review",
      "",
      "### Потенциальные баги",
      findings.bugs.length
        ? findings.bugs.map((item) => `- ${item}`).join("\n")
        : "- Явных багов по diff не найдено. Это mock/fallback-режим, поэтому вывод ограничен эвристиками.",
      "",
      "### Архитектурные проблемы",
      findings.architecture.length
        ? findings.architecture.map((item) => `- ${item}`).join("\n")
        : "- Крупных архитектурных конфликтов по diff не найдено.",
      "",
      "### Рекомендации",
      findings.recommendations.length
        ? findings.recommendations.map((item) => `- ${item}`).join("\n")
        : "- Добавьте тест или демонстрационный сценарий для измененного поведения.",
      "",
      "### Использованный контекст",
      `- Branch: ${prContext.branch}`,
      `- Diff range: ${prContext.range}`,
      `- Changed files: ${prContext.changedFiles.join(", ") || "нет"}`,
      "",
      this.formatSources(chunks)
    ].join("\n");
  }

  heuristicFindings(prContext) {
    const diff = prContext.diff;
    const changed = prContext.changedFiles.join(", ");
    const bugs = [];
    const architecture = [];
    const recommendations = [];

    if (/fetch\(/.test(diff) && !/try\s*{/.test(diff)) {
      bugs.push("В изменениях есть сетевой `fetch`, но рядом не видно обработки ошибки. Добавьте `try/catch` или понятный fallback.");
    }
    if (/JSON\.parse/.test(diff) && !/catch/.test(diff)) {
      bugs.push("В изменениях есть `JSON.parse` без явной обработки некорректного JSON. Это может ронять пайплайн.");
    }
    if (/GIGACHAT_AUTH_KEY/.test(diff) && !/process\.env/.test(diff)) {
      bugs.push("Проверьте, что ключ GigaChat не захардкожен и берется только из переменных окружения.");
    }
    if (/\.github\/workflows/.test(changed) && !/permissions:/.test(diff)) {
      architecture.push("GitHub Action лучше ограничить через `permissions`, чтобы workflow не получал лишние права.");
    }
    if (/agent|assistant|review/i.test(changed) && !/README\.md/.test(changed)) {
      recommendations.push("Поведение ассистента изменено без обновления README. Добавьте команды запуска и сценарий демонстрации.");
    }
    if (!/node --check|npm test|npm run/.test(diff) && /\.(js|mjs)/.test(changed)) {
      recommendations.push("Для JS-изменений добавьте хотя бы `node --check` или smoke-команду в пайплайн.");
    }

    return { bugs, architecture, recommendations };
  }

  formatSources(chunks) {
    return [
      "### RAG Sources",
      ...chunks.map((chunk) =>
        `- ${chunk.source}; section=${chunk.section}; lines=${chunk.lineStart}-${chunk.lineEnd}; chunk_id=${chunk.chunkId}; score=${chunk.score.toFixed(2)}`
      )
    ].join("\n");
  }

  emptyReview(prContext) {
    return [
      "## AI Code Review",
      "",
      "Diff пустой, ревью выполнять не по чему.",
      "",
      "### Pipeline Context",
      `- Branch: ${prContext.branch}`,
      `- Diff range: ${prContext.range}`
    ].join("\n");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const prContext = await collectPullRequestContext(args);
  const rag = new ReviewRagIndex();
  await rag.build(prContext.changedFiles);
  const query = [
    prContext.changedFiles.join(" "),
    prContext.diff.slice(0, MAX_DIFF_CHARS)
  ].join("\n");
  const chunks = rag.search(query);
  const agent = new PullRequestReviewAgent({ mock: args.mock });
  const review = await agent.review({
    prContext,
    ragContext: rag.format(chunks),
    chunks
  });

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${review.trim()}\n`, "utf8");
  console.log(`AI review saved to ${args.output}`);
  console.log(`Changed files: ${prContext.changedFiles.length}`);
  console.log(`RAG chunks: ${chunks.length}`);
}

main().catch((error) => {
  console.error(`PR review failed: ${error.message}`);
  process.exitCode = 1;
});
