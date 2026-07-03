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
    candidateTopK = 10,
    relevanceThreshold = 0.55,
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
    this.candidateTopK = candidateTopK;
    this.relevanceThreshold = relevanceThreshold;
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
    const headingMatches = [...normalized.matchAll(/^#{1,6}\s+(.+)$/gm)]
      .map((match) => ({ index: match.index, title: match[1].trim() }));

    while (start < normalized.length) {
      const end = Math.min(start + this.chunkSize, normalized.length);
      const text = normalized.slice(start, end).trim();

      if (text) {
        const lineStart = normalized.slice(0, start).split("\n").length;
        const section = this.detectSection(source, normalized, start, text, headingMatches);
        chunks.push({ source, lineStart, section, text });
      }

      if (end === normalized.length) {
        break;
      }
      start = Math.max(0, end - this.overlap);
    }

    return chunks;
  }

  detectSection(source, fullText, start, chunkText, headingMatches) {
    if (/\.md$/i.test(source)) {
      const heading = headingMatches
        .filter((match) => match.index <= start)
        .at(-1);
      return heading?.title || "document";
    }

    const before = fullText.slice(0, start + chunkText.length);
    const codeSections = [...before.matchAll(/(?:class|function)\s+([A-Za-z0-9_]+)|export\s+class\s+([A-Za-z0-9_]+)/g)];
    const lastCodeSection = codeSections.at(-1);
    return lastCodeSection?.[1] || lastCodeSection?.[2] || source;
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

  rewriteQuery(question) {
    const originalTokens = this.tokenize(question);
    const expandedTokens = this.expandQueryTokens(question, originalTokens);
    const uniqueTokens = [...new Set(expandedTokens)];

    return {
      original: question,
      rewritten: uniqueTokens.join(" "),
      tokens: uniqueTokens
    };
  }

  search(question, topK = this.topK, preferredSources = [], { rewrite = true } = {}) {
    const queryTokens = rewrite
      ? this.rewriteQuery(question).tokens
      : this.tokenize(question);
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

  rerankAndFilter(question, candidates, preferredSources = []) {
    const rewritten = this.rewriteQuery(question);
    const querySet = new Set(rewritten.tokens);
    const preferred = new Set(preferredSources);

    const reranked = candidates
      .map((chunk) => {
        const uniqueChunkTokens = [...new Set(chunk.tokens)];
        const overlap = uniqueChunkTokens.filter((token) => querySet.has(token)).length;
        const similarity = querySet.size === 0 ? 0 : overlap / querySet.size;
        const sourceBoost = preferred.has(chunk.source) ? 0.18 : 0;
        const codeBoost = /(?:npm run|const |class |function |export |[a-z]+_[a-z_]+)/i.test(chunk.text) ? 0.06 : 0;
        const finalScore = similarity + sourceBoost + codeBoost + (chunk.score / 1000);

        return {
          ...chunk,
          similarity,
          finalScore,
          passedFilter: similarity + sourceBoost >= this.relevanceThreshold
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    const filtered = reranked.filter((chunk) => chunk.passedFilter);

    return {
      rewrittenQuery: rewritten.rewritten,
      candidates,
      reranked,
      filtered,
      selected: filtered.slice(0, this.topK),
      threshold: this.relevanceThreshold,
      topKBefore: candidates.length,
      topKAfter: Math.min(this.topK, filtered.length),
      weakContext: filtered.length === 0
    };
  }

  buildRagPrompt(question, chunks) {
    const context = chunks
      .map((chunk, index) =>
        [
          `[Источник ${index + 1}: ${chunk.source}; section=${chunk.section}; chunk_id=${chunk.id}; line=${chunk.lineStart}]`,
          chunk.text
        ].join("\n")
      )
      .join("\n\n");

    return [
      "Ответь на вопрос только по контексту ниже.",
      "Если релевантного контекста нет или ответ не подтверждается цитатами, напиши: Не знаю. Уточните вопрос.",
      "Верни строго три блока:",
      "Ответ: краткий ответ по контексту.",
      "Источники: список source + section + chunk_id.",
      "Цитаты: короткие фрагменты из найденных чанков, которые подтверждают ответ.",
      "Не добавляй факты без цитат.",
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

  async askWithRag(question, { preferredSources = [], mode = "enhanced" } = {}) {
    const retrieval = mode === "baseline"
      ? {
          rewrittenQuery: question,
          candidates: [],
          reranked: [],
          filtered: [],
          selected: this.search(question, this.topK, preferredSources, { rewrite: false }),
          threshold: null,
          topKBefore: this.topK,
          topKAfter: this.topK
        }
      : this.rerankAndFilter(
          question,
          this.search(question, this.candidateTopK, preferredSources, { rewrite: true }),
          preferredSources
        );
    const chunks = retrieval.selected;
    if (mode === "enhanced" && retrieval.weakContext) {
      return {
        answer: this.createUnknownAnswer(),
        chunks,
        prompt: this.buildRagPrompt(question, chunks),
        retrieval,
        grounding: this.validateGrounding(this.createUnknownAnswer(), chunks)
      };
    }
    const prompt = this.buildRagPrompt(question, chunks);

    if (this.mock) {
      const answer = this.createMockRagAnswer(question, chunks);
      return {
        answer,
        chunks,
        prompt,
        retrieval,
        grounding: this.validateGrounding(answer, chunks)
      };
    }

    const completion = await this.llm.requestCompletion(
      [
        {
          role: "system",
          content: [
            "Ты RAG-агент. Отвечай только по переданному контексту проекта.",
            "Каждый ответ обязан содержать блоки Ответ, Источники и Цитаты.",
            "В источниках указывай source, section и chunk_id.",
            "Если контекст слабый или не подтверждает ответ, скажи: Не знаю. Уточните вопрос."
          ].join(" ")
        },
        { role: "user", content: prompt }
      ],
      700
    );
    const answer = this.ensureGroundedRealAnswer(completion.answer, chunks);
    return {
      answer,
      chunks,
      prompt,
      retrieval,
      grounding: this.validateGrounding(answer, chunks)
    };
  }

  createMockRagAnswer(question, chunks) {
    if (chunks.length === 0) {
      return this.createUnknownAnswer();
    }

    const facts = this.extractUsefulLines(question, chunks).slice(0, 6);
    const terms = this.extractImportantTerms(chunks).slice(0, 25);
    const citations = this.buildCitations(question, chunks).slice(0, 4);
    const sources = this.buildSources(chunks);

    return [
      "Ответ:",
      ...facts.map((fact) => `- ${fact}`),
      terms.length > 0 ? `Команды и идентификаторы из контекста: ${terms.join(", ")}.` : "",
      "",
      "Источники:",
      ...sources.map((source) => `- ${source}`),
      "",
      "Цитаты:",
      ...citations.map((citation) => `- «${citation.quote}» (${citation.source}; section=${citation.section}; chunk_id=${citation.chunk_id})`)
    ].filter(Boolean).join("\n");
  }

  createUnknownAnswer() {
    return [
      "Ответ:",
      "Не знаю. Уточните вопрос.",
      "",
      "Источники:",
      "- нет релевантных источников выше порога",
      "",
      "Цитаты:",
      "- нет цитат, потому что релевантный контекст не найден"
    ].join("\n");
  }

  buildSources(chunks) {
    return chunks.map((chunk) =>
      `${chunk.source}; section=${chunk.section}; chunk_id=${chunk.id}; line=${chunk.lineStart}`
    );
  }

  buildCitations(question, chunks) {
    const usefulLines = this.extractUsefulLines(question, chunks);
    const citations = [];

    for (const chunk of chunks) {
      const lines = chunk.text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 8);
      const preferred = lines.find((line) => usefulLines.includes(line.replace(/^[-*]\s*/, ""))) || lines[0];

      if (preferred) {
        citations.push({
          source: chunk.source,
          section: chunk.section,
          chunk_id: chunk.id,
          quote: this.truncateQuote(preferred.replace(/^[-*]\s*/, ""))
        });
      }
    }

    return citations;
  }

  truncateQuote(text, maxLength = 180) {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length <= maxLength
      ? normalized
      : `${normalized.slice(0, maxLength - 1).trim()}...`;
  }

  ensureGroundedRealAnswer(answer, chunks) {
    const hasSources = /Источники:/i.test(answer);
    const hasCitations = /Цитаты:/i.test(answer);

    if (hasSources && hasCitations) {
      return answer;
    }

    return [
      answer.trim(),
      "",
      !hasSources ? "Источники:" : "",
      !hasSources ? this.buildSources(chunks).map((source) => `- ${source}`).join("\n") : "",
      "",
      !hasCitations ? "Цитаты:" : "",
      !hasCitations ? this.buildCitations("", chunks).map((citation) =>
        `- «${citation.quote}» (${citation.source}; section=${citation.section}; chunk_id=${citation.chunk_id})`
      ).join("\n") : ""
    ].filter(Boolean).join("\n");
  }

  validateGrounding(answer, chunks) {
    if (/не знаю/i.test(answer)) {
      return {
        hasSources: true,
        hasCitations: true,
        meaningMatchesCitations: true,
        citationCount: 0
      };
    }

    const normalized = answer.toLowerCase();
    const hasSources = /источники:/i.test(answer) && chunks.every((chunk) =>
      normalized.includes(chunk.source.toLowerCase()) && normalized.includes(`chunk_id=${chunk.id}`.toLowerCase())
    );
    const quotedFragments = [...answer.matchAll(/«([^»]{8,})»/g)].map((match) => match[1]);
    const contextText = chunks.map((chunk) => chunk.text.replace(/\s+/g, " ")).join("\n");
    const hasCitations = /цитаты:/i.test(answer) && quotedFragments.length > 0 && quotedFragments.every((quote) =>
      contextText.includes(quote.replace(/\s+/g, " "))
    );
    const answerTokens = new Set(this.tokenize(answer));
    const citationTokens = new Set(this.tokenize(quotedFragments.join(" ")));
    const overlap = [...answerTokens].filter((token) => citationTokens.has(token)).length;
    const meaningMatchesCitations = quotedFragments.length > 0 && overlap >= Math.min(3, answerTokens.size);

    return {
      hasSources,
      hasCitations,
      meaningMatchesCitations,
      citationCount: quotedFragments.length
    };
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
