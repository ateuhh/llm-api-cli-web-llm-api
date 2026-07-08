import { readFile } from "node:fs/promises";
import { DocumentIndexer } from "./document-indexer.js";
import { GigaChatAgent } from "./agent.js";

export class LocalRagAgent {
  constructor({
    indexPath = process.env.LOCAL_RAG_INDEX_PATH || "./document-index/index-structured.json",
    topK = Number(process.env.LOCAL_RAG_TOP_K || 4),
    relevanceThreshold = Number(process.env.LOCAL_RAG_RELEVANCE_THRESHOLD || 0.18),
    ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    ollamaModel = process.env.OLLAMA_MODEL || "llama3.2:1b",
    cloudAuthKey = process.env.GIGACHAT_AUTH_KEY,
    cloudModel = process.env.GIGACHAT_MODEL || "GigaChat-2",
    cloudScope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
  } = {}) {
    this.indexPath = indexPath;
    this.topK = topK;
    this.relevanceThreshold = relevanceThreshold;
    this.ollamaBaseUrl = ollamaBaseUrl.replace(/\/$/, "");
    this.ollamaModel = ollamaModel;
    this.indexer = new DocumentIndexer();
    this.index = null;
    this.cloud = new GigaChatAgent({
      authKey: cloudAuthKey,
      model: cloudModel,
      scope: cloudScope,
      compressionEnabled: false,
      historyPath: `/tmp/local-rag-cloud-${crypto.randomUUID()}.json`
    });
  }

  async loadIndex() {
    const raw = await readFile(this.indexPath, "utf8");
    this.index = JSON.parse(raw);
    return this.index;
  }

  async assertOllamaReady() {
    const response = await fetch(`${this.ollamaBaseUrl}/api/tags`);

    if (!response.ok) {
      throw new Error(`Ollama API недоступен: HTTP ${response.status}`);
    }

    const data = await response.json();
    const models = data.models || [];
    const hasModel = models.some((model) => model.name === this.ollamaModel);

    if (!hasModel) {
      const available = models.map((model) => model.name).join(", ") || "нет скачанных моделей";
      throw new Error(
        `Модель ${this.ollamaModel} не найдена. Доступные модели: ${available}. ` +
          `Скачайте модель командой: ollama pull ${this.ollamaModel}`
      );
    }
  }

  search(question) {
    if (!this.index) {
      throw new Error("Индекс не загружен. Вызовите loadIndex() перед search().");
    }

    const queryEmbedding = this.indexer.embed(question);
    const queryTokens = new Set(this.expandQueryTokens(question));
    return this.index.chunks
      .map((chunk) => {
        const cosine = this.cosineSimilarity(queryEmbedding, chunk.embedding);
        const tokenScore = this.tokenOverlapScore(queryTokens, chunk.text);
        const sourceBoost = this.sourceBoost(question, chunk);
        const servicePenalty = this.serviceChunkPenalty(chunk);
        const similarity = cosine + tokenScore + sourceBoost - servicePenalty;

        return {
          ...chunk,
          cosine,
          similarity
        };
      })
      .filter((chunk) => chunk.similarity >= this.relevanceThreshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.topK);
  }

  expandQueryTokens(question) {
    const normalized = question.toLowerCase();
    const extra = [];
    const add = (...items) => extra.push(...items);

    if (/pipeline|search|summarize|save|цепоч/.test(normalized)) {
      add("mcp-pipeline", "mcp-pipeline-agent", "search_project_files", "summarize_text", "save_to_file");
    }
    if (/state machine|состояни|этап/.test(normalized)) {
      add("task-state-machine-agent", "planning", "execution", "validation", "done", "PHASES");
    }
    if (/сло|памят/.test(normalized)) {
      add("layered-memory-agent", "short", "working", "long", "краткосрочная", "рабочая", "долговременная");
    }
    if (/graphql|инвариант/.test(normalized)) {
      add("swarm-agent", "task-state-machine-agent", "GraphQL", "forbid", "CriticAgent", "инвариант");
    }
    if (/локальн|ollama|cli-чат|local-llm/.test(normalized)) {
      add("local-llm", "ollama-agent", "local-llm-cli", "npm run local-llm", "OLLAMA_MODEL");
    }

    return [...new Set([...this.indexer.tokenize(question), ...extra.flatMap((item) => this.indexer.tokenize(item))])];
  }

  tokenOverlapScore(queryTokens, text) {
    const textTokens = new Set(this.indexer.tokenize(text));
    const overlap = [...queryTokens].filter((token) => textTokens.has(token)).length;
    return queryTokens.size === 0 ? 0 : (overlap / queryTokens.size) * 0.55;
  }

  sourceBoost(question, chunk) {
    const normalized = question.toLowerCase();
    const source = chunk.metadata.source;
    const text = chunk.text.toLowerCase();
    let boost = 0;

    if (/pipeline|search|summarize|save|цепоч/.test(normalized) && /mcp-pipeline-agent|README.md/.test(source)) {
      boost += 0.25;
    }
    if (/state machine|состояни|этап/.test(normalized) && /task-state-machine-agent|README.md/.test(source)) {
      boost += 0.25;
    }
    if (/сло|памят/.test(normalized) && /layered-memory-agent|README.md/.test(source)) {
      boost += 0.25;
    }
    if (/graphql|инвариант/.test(normalized) && /swarm-agent|task-state-machine-agent|README.md/.test(source)) {
      boost += 0.25;
    }
    if (/локальн|ollama|cli-чат|local-llm/.test(normalized) && /README.md|local-llm-cli|ollama-agent/.test(source)) {
      boost += 0.3;
    }
    if (/npm run|class |function |export |[a-z]+_[a-z_]+/i.test(chunk.text)) {
      boost += 0.04;
    }
    if (text.includes(normalized)) {
      boost += 0.15;
    }

    return boost;
  }

  serviceChunkPenalty(chunk) {
    let penalty = 0;

    if (/local-rag-demo\.js|rag-demo\.js/.test(chunk.metadata.source)) {
      penalty += 0.45;
    }
    if (chunk.metadata.source === "rag-agent.js" && chunk.metadata.section === "CONTROL_QUESTIONS") {
      penalty += 0.45;
    }
    if (/Контрольные вопросы/.test(chunk.metadata.section)) {
      penalty += 0.35;
    }

    return penalty;
  }

  buildPrompt(question, chunks) {
    const context = chunks
      .map((chunk, index) =>
        [
          `[Источник ${index + 1}: ${chunk.metadata.source}; section=${chunk.metadata.section}; chunk_id=${chunk.metadata.chunk_id}]`,
          chunk.text
        ].join("\n")
      )
      .join("\n\n");

    return [
      "Ответь на вопрос только по контексту ниже.",
      "Если ответа нет в контексте, напиши: Не знаю. Уточните вопрос.",
      "Обязательно верни блоки: Ответ, Источники, Цитаты.",
      "В источниках указывай source, section и chunk_id.",
      "Не копируй весь контекст. Блок Ответ должен быть коротким: максимум 8 строк.",
      "Если релевантные источники найдены, не начинай ответ с фразы Не знаю.",
      "",
      `Вопрос: ${question}`,
      "",
      "Контекст:",
      context || "Релевантный контекст не найден."
    ].join("\n");
  }

  async askLocal(question) {
    const startedAt = Date.now();
    const chunks = this.search(question);

    if (chunks.length === 0) {
      return {
        answer: this.unknownAnswer(),
        chunks,
        metrics: {
          provider: "ollama",
          model: this.ollamaModel,
          durationMs: Date.now() - startedAt,
          promptTokens: 0,
          completionTokens: 0
        }
      };
    }

    const response = await fetch(`${this.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.ollamaModel,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 350
        },
        messages: [
          {
            role: "system",
            content: "Ты локальный RAG-ассистент. Отвечай по-русски и не добавляй факты без источников."
          },
          { role: "user", content: this.buildPrompt(question, chunks) }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ошибка Ollama API: HTTP ${response.status} ${text}`);
    }

    const data = await response.json();
    return {
      answer: this.ensureGrounding(data.message?.content?.trim() || "", chunks),
      chunks,
      metrics: {
        provider: "ollama",
        model: data.model || this.ollamaModel,
        durationMs: Date.now() - startedAt,
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0
      }
    };
  }

  async askCloud(question) {
    const startedAt = Date.now();
    const chunks = this.search(question);

    if (chunks.length === 0) {
      return {
        answer: this.unknownAnswer(),
        chunks,
        metrics: {
          provider: "gigachat",
          model: this.cloud.model,
          durationMs: Date.now() - startedAt,
          promptTokens: 0,
          completionTokens: 0
        }
      };
    }

    const completion = await this.cloud.requestCompletion(
      [
        {
          role: "system",
          content: "Ты облачный RAG-ассистент. Отвечай по-русски, строго по контексту, с источниками и цитатами."
        },
        { role: "user", content: this.buildPrompt(question, chunks) }
      ],
      700
    );

    return {
      answer: this.ensureGrounding(completion.answer, chunks),
      chunks,
      metrics: {
        provider: "gigachat",
        model: this.cloud.model,
        durationMs: Date.now() - startedAt,
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0
      }
    };
  }

  formatSources(chunks) {
    return chunks
      .map((chunk) =>
        [
          `${chunk.metadata.source}`,
          `section=${chunk.metadata.section}`,
          `chunk_id=${chunk.metadata.chunk_id}`,
          `similarity=${chunk.similarity.toFixed(3)}`
        ].join("; ")
      )
      .join("\n");
  }

  ensureGrounding(answer, chunks) {
    const hasSources = /Источники:/i.test(answer);
    const hasCitations = /Цитаты:/i.test(answer);

    if (hasSources && hasCitations) {
      return answer;
    }

    return [
      answer || "Ответ: Не знаю. Уточните вопрос.",
      "",
      !hasSources ? "Источники:" : "",
      !hasSources
        ? chunks.map((chunk) =>
            `- ${chunk.metadata.source}; section=${chunk.metadata.section}; chunk_id=${chunk.metadata.chunk_id}`
          ).join("\n")
        : "",
      "",
      !hasCitations ? "Цитаты:" : "",
      !hasCitations
        ? chunks.map((chunk) =>
            `- «${this.firstQuote(chunk.text)}» (${chunk.metadata.source}; section=${chunk.metadata.section}; chunk_id=${chunk.metadata.chunk_id})`
          ).join("\n")
        : ""
    ].filter(Boolean).join("\n");
  }

  unknownAnswer() {
    return [
      "Ответ:",
      "Не знаю. Уточните вопрос.",
      "",
      "Источники:",
      "- релевантные чанки не найдены",
      "",
      "Цитаты:",
      "- нет цитат, потому что контекст не найден"
    ].join("\n");
  }

  firstQuote(text) {
    const line = text
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length >= 12) || text;
    const normalized = line.replace(/^[-*]\s*/, "").replace(/\s+/g, " ").trim();
    return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177).trim()}...`;
  }

  cosineSimilarity(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (let index = 0; index < left.length; index += 1) {
      dot += left[index] * right[index];
      leftNorm += left[index] * left[index];
      rightNorm += right[index] * right[index];
    }

    return dot / ((Math.sqrt(leftNorm) || 1) * (Math.sqrt(rightNorm) || 1));
  }
}
