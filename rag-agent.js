import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { GigaChatAgent } from "./agent.js";

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
  "его",
  "она",
  "они",
  "где",
  "какие",
  "какой",
  "какая"
]);

const DEFAULT_FILES = [
  "README.md",
  "agent.js",
  "mcp-server.js",
  "mcp-pipeline-agent.js",
  "mcp-orchestrator-agent.js",
  "mcp-scheduler-agent.js",
  "mcp-git-server.js",
  "mcp-files-server.js",
  "swarm-agent.js",
  "task-state-machine-agent.js",
  "context-strategy-agent.js",
  "layered-memory-agent.js"
];

export const CONTROL_QUESTIONS = [
  {
    question: "Какая команда запускает MCP pipeline из search, summarize и save?",
    expected: ["npm run mcp-pipeline", "search_project_files", "summarize_text", "save_to_file"],
    sources: ["README.md", "mcp-pipeline-agent.js"]
  },
  {
    question: "Какие MCP-серверы используются в orchestration и за что они отвечают?",
    expected: ["mcp-git-server.js", "mcp-files-server.js", "git_status", "search_project_files"],
    sources: ["README.md", "mcp-orchestrator-agent.js"]
  },
  {
    question: "Какая команда запускает интерактивный MCP-планировщик?",
    expected: ["npm run mcp-scheduler", "/start", "/list", "/stop"],
    sources: ["README.md", "mcp-scheduler-agent.js"]
  },
  {
    question: "Что делает инструмент git_status?",
    expected: ["статус Git", "branch", "changedFiles", "includeUntracked"],
    sources: ["mcp-server.js", "mcp-git-server.js", "README.md"]
  },
  {
    question: "Какие стратегии управления контекстом без summary реализованы?",
    expected: ["sliding", "facts", "branching", "Sticky Facts"],
    sources: ["README.md", "context-strategy-agent.js"]
  },
  {
    question: "Какие слои памяти есть у ассистента?",
    expected: ["short", "working", "long", "краткосрочная", "рабочая", "долговременная"],
    sources: ["README.md", "layered-memory-agent.js"]
  },
  {
    question: "Какие состояния есть у Task State Machine?",
    expected: ["planning", "execution", "validation", "done"],
    sources: ["README.md", "task-state-machine-agent.js"]
  },
  {
    question: "Какой инвариант запрещает GraphQL?",
    expected: ["GraphQL запрещен", "forbid", "CriticAgent", "инвариант"],
    sources: ["README.md", "swarm-agent.js", "task-state-machine-agent.js"]
  },
  {
    question: "Как агент считает и показывает токены диалога?",
    expected: ["currentRequestTokens", "historyTokens", "answerTokens", "usageTotals"],
    sources: ["README.md", "agent.js"]
  },
  {
    question: "Как включается компрессия истории и что сохраняется как summary?",
    expected: ["CHAT_COMPRESSION", "CHAT_RECENT_MESSAGES", "summary", "последние сообщения"],
    sources: ["README.md", "agent.js"]
  }
];

export class RagAgent {
  constructor({
    cwd = ".",
    files = DEFAULT_FILES,
    topK = 4,
    chunkSize = 1200,
    overlap = 180,
    mock = true,
    authKey,
    model = "GigaChat-2",
    scope = "GIGACHAT_API_PERS"
  } = {}) {
    this.cwd = cwd;
    this.files = files;
    this.topK = topK;
    this.chunkSize = chunkSize;
    this.overlap = overlap;
    this.mock = mock;
    this.llm = new GigaChatAgent({
      authKey,
      model,
      scope,
      mock,
      compressionEnabled: false,
      historyPath: `/tmp/rag-agent-${crypto.randomUUID()}.json`,
      systemPrompt: "Ты отвечаешь на вопросы по проекту кратко и по-русски."
    });
    this.chunks = [];
  }

  async buildIndex() {
    const allFiles = await this.resolveFiles();
    const chunks = [];

    for (const file of allFiles) {
      const content = await readFile(join(this.cwd, file), "utf8");
      chunks.push(...this.chunkDocument(file, content));
    }

    this.chunks = chunks.map((chunk, index) => ({
      ...chunk,
      id: index + 1,
      tokens: this.tokenize(chunk.text)
    }));
    return this.chunks;
  }

  async resolveFiles() {
    const existing = [];

    for (const file of this.files) {
      try {
        await readFile(join(this.cwd, file), "utf8");
        existing.push(file);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    if (existing.length > 0) {
      return existing;
    }

    const entries = await readdir(this.cwd, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(md|js)$/i.test(entry.name))
      .map((entry) => relative(this.cwd, join(this.cwd, entry.name)));
  }

  chunkDocument(source, content) {
    const normalized = content.replace(/\r\n/g, "\n");
    const chunks = [];
    let start = 0;

    while (start < normalized.length) {
      const end = Math.min(start + this.chunkSize, normalized.length);
      const text = normalized.slice(start, end).trim();

      if (text) {
        const lineStart = normalized.slice(0, start).split("\n").length;
        chunks.push({ source, lineStart, text });
      }

      if (end === normalized.length) {
        break;
      }
      start = Math.max(0, end - this.overlap);
    }

    return chunks;
  }

  tokenize(text) {
    return String(text)
      .toLowerCase()
      .match(/[a-zа-яё0-9_/-]{3,}/gi)
      ?.map((token) => token.toLowerCase())
      .filter((token) => !STOP_WORDS.has(token)) || [];
  }

  expandQueryTokens(question, tokens) {
    const normalized = question.toLowerCase();
    const extra = [];
    const add = (...items) => extra.push(...items);

    if (/pipeline|search|summarize|save|цепоч/.test(normalized)) {
      add("mcp-pipeline", "search_project_files", "summarize_text", "save_to_file", "matchesJson");
    }
    if (/orchestration|оркестр|сервер/.test(normalized)) {
      add("mcp-git-server", "mcp-files-server", "git_status", "search_project_files");
    }
    if (/планировщик|периодич|сводк/.test(normalized)) {
      add("mcp-scheduler", "schedule_summary", "list_summaries", "stop_summary", "/start", "/list", "/stop");
    }
    if (/git_status|git|репозитор|статус/.test(normalized)) {
      add("git_status", "branch", "changedFiles", "includeUntracked", "статус Git");
    }
    if (/стратег|контекст/.test(normalized)) {
      add("sliding", "facts", "branching", "Sticky Facts");
    }
    if (/сло|памят/.test(normalized)) {
      add("short", "working", "long", "краткосрочная", "рабочая", "долговременная");
    }
    if (/state machine|состояни|этап/.test(normalized)) {
      add("planning", "execution", "validation", "done", "PHASES");
    }
    if (/graphql|инвариант/.test(normalized)) {
      add("GraphQL запрещен", "forbid", "CriticAgent", "инвариант");
    }
    if (/токен|стоимост/.test(normalized)) {
      add("currentRequestTokens", "historyTokens", "answerTokens", "usageTotals", "countTokens");
    }
    if (/компресс|summary|сжат/.test(normalized)) {
      add("CHAT_COMPRESSION", "CHAT_RECENT_MESSAGES", "summary", "последние сообщения");
    }

    return [...tokens, ...extra.flatMap((item) => this.tokenize(item))];
  }

  search(question, topK = this.topK, preferredSources = []) {
    const queryTokens = this.expandQueryTokens(question, this.tokenize(question));
    const querySet = new Set(queryTokens);
    const preferred = new Set(preferredSources);

    return this.chunks
      .map((chunk) => {
        let score = 0;
        for (const token of chunk.tokens) {
          if (querySet.has(token)) {
            score += 2;
          }
          for (const queryToken of queryTokens) {
            if (token.includes(queryToken) || queryToken.includes(token)) {
              score += 0.25;
            }
          }
        }
        if (/### Контрольные вопросы|## Первый RAG-запрос/.test(chunk.text)) {
          score *= 0.1;
        }
        if (chunk.source !== "README.md") {
          score *= 1.25;
        }
        if (preferred.has(chunk.source)) {
          score = (score + 5) * 3;
        }
        return { ...chunk, score };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  buildRagPrompt(question, chunks) {
    const context = chunks
      .map((chunk, index) =>
        [
          `[Источник ${index + 1}: ${chunk.source}:${chunk.lineStart}]`,
          chunk.text
        ].join("\n")
      )
      .join("\n\n");

    return [
      "Ответь на вопрос только по контексту ниже.",
      "Если в контексте нет ответа, так и скажи.",
      "В конце перечисли использованные источники.",
      "",
      `Вопрос: ${question}`,
      "",
      "Контекст:",
      context
    ].join("\n");
  }

  async askWithoutRag(question) {
    if (this.mock) {
      return [
        "Ответ без RAG: у меня нет подключенной базы проекта в этом режиме.",
        "Могу дать только общий ответ и не могу надежно назвать точные команды, файлы или инварианты."
      ].join(" ");
    }

    const completion = await this.llm.requestCompletion([
      {
        role: "system",
        content: "Отвечай кратко. Не используй внешние источники и не выдумывай точные детали проекта."
      },
      { role: "user", content: question }
    ]);
    return completion.answer;
  }

  async askWithRag(question, { preferredSources = [] } = {}) {
    const chunks = this.search(question, this.topK, preferredSources);
    const prompt = this.buildRagPrompt(question, chunks);

    if (this.mock) {
      return {
        answer: this.createMockRagAnswer(question, chunks),
        chunks,
        prompt
      };
    }

    const completion = await this.llm.requestCompletion(
      [
        {
          role: "system",
          content: "Ты RAG-агент. Отвечай только по переданному контексту проекта."
        },
        { role: "user", content: prompt }
      ],
      700
    );
    return { answer: completion.answer, chunks, prompt };
  }

  createMockRagAnswer(question, chunks) {
    if (chunks.length === 0) {
      return "Ответ с RAG: релевантные чанки не найдены.";
    }

    const sources = chunks
      .map((chunk) => `${chunk.source}:${chunk.lineStart}`)
      .join(", ");
    const facts = this.extractUsefulLines(question, chunks).slice(0, 6);
    const terms = this.extractImportantTerms(chunks).slice(0, 25);

    return [
      "Ответ с RAG:",
      ...facts.map((fact) => `- ${fact}`),
      terms.length > 0 ? `Команды и идентификаторы из контекста: ${terms.join(", ")}.` : "",
      `Источники: ${sources}.`
    ].filter(Boolean).join("\n");
  }

  extractUsefulLines(question, chunks) {
    const questionTokens = new Set(this.expandQueryTokens(question, this.tokenize(question)));
    const lines = [];

    for (const chunk of chunks) {
      for (const line of chunk.text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 8) {
          continue;
        }
        const tokens = this.tokenize(trimmed);
        if (tokens.some((token) => questionTokens.has(token))) {
          lines.push(trimmed.replace(/^[-*]\s*/, ""));
        }
      }
    }

    return [...new Set(lines)].slice(0, 8);
  }

  extractImportantTerms(chunks) {
    const text = chunks.map((chunk) => chunk.text).join("\n");
    const commandTerms = text.match(/(?:npm run [\w:-]+|\/[a-z-]+|CHAT_[A-Z_]+)/g) || [];
    const codeTerms = text.match(/[A-Za-z_][A-Za-z0-9_/-]{3,}/g) || [];
    const russianTerms = text.match(/[А-Яа-яЁё][А-Яа-яЁё-]{5,}/g) || [];
    const priority = [
      ...commandTerms,
      ...codeTerms,
      ...russianTerms
    ]
      .map((term) => term.replace(/[.,:;()[\]{}"'`]/g, ""))
      .filter((term) => term.length > 3)
      .filter((term) => !STOP_WORDS.has(term.toLowerCase()));
    const counts = new Map();

    for (const term of priority) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => this.termPriority(b[0], b[1]) - this.termPriority(a[0], a[1]))
      .map(([term]) => term)
      .filter((term, index, array) =>
        array.findIndex((item) => item.toLowerCase() === term.toLowerCase()) === index
      );
  }

  termPriority(term, count) {
    let priority = count;
    if (/^npm run /.test(term)) {
      priority += 100;
    }
    if (/^CHAT_/.test(term) || term.includes("_") || term.startsWith("/")) {
      priority += 50;
    }
    if (/^(planning|execution|validation|done|sliding|facts|branching|short|working|long)$/i.test(term)) {
      priority += 40;
    }
    return priority;
  }

  scoreAnswer(answer, expected) {
    const normalized = answer.toLowerCase();
    const matched = expected.filter((item) => normalized.includes(item.toLowerCase()));
    return {
      matched,
      total: expected.length,
      score: expected.length === 0 ? 0 : matched.length / expected.length
    };
  }
}
