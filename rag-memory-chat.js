import { readFile, rename, writeFile } from "node:fs/promises";
import { RagAgent } from "./rag-agent.js";

const DEFAULT_STATE = {
  messages: [],
  taskMemory: {
    goal: "",
    clarifications: [],
    constraints: [],
    terms: [],
    decisions: []
  }
};

export class RagMemoryChat {
  constructor({
    statePath = "rag-chat-state.json",
    recentMessages = 8,
    ragOptions = {}
  } = {}) {
    this.statePath = statePath;
    this.recentMessages = recentMessages;
    this.rag = new RagAgent(ragOptions);
    this.state = structuredClone(DEFAULT_STATE);
  }

  async init() {
    await this.rag.buildIndex();
    await this.loadState();
  }

  async loadState() {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const saved = JSON.parse(raw);
      this.state = {
        messages: Array.isArray(saved.messages) ? saved.messages : [],
        taskMemory: {
          ...structuredClone(DEFAULT_STATE.taskMemory),
          ...(saved.taskMemory || {})
        }
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.state = structuredClone(DEFAULT_STATE);
    }
  }

  async saveState() {
    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmpPath, this.statePath);
  }

  async reset() {
    this.state = structuredClone(DEFAULT_STATE);
    await this.saveState();
  }

  async ask(userInput) {
    const userMessage = this.createMessage("user", userInput);
    this.state.messages.push(userMessage);
    this.updateTaskMemory(userInput);

    const enrichedQuestion = this.buildRagQuestion(userInput);
    let ragResult = await this.rag.askWithRag(enrichedQuestion, {
      mode: "enhanced",
      searchQuestion: userInput
    });
    if (ragResult.chunks.length === 0) {
      ragResult = await this.rag.askWithRag(enrichedQuestion, {
        mode: "enhanced",
        searchQuestion: this.buildMemorySearchQuestion(userInput)
      });
    }
    if (ragResult.chunks.length === 0) {
      ragResult = await this.rag.askWithRag(enrichedQuestion, {
        mode: "baseline",
        searchQuestion: this.buildMemorySearchQuestion(userInput)
      });
    }
    const assistantMessage = this.createMessage("assistant", ragResult.answer, {
      sources: this.rag.buildSources(ragResult.chunks),
      grounding: ragResult.grounding
    });
    this.state.messages.push(assistantMessage);
    await this.saveState();

    return {
      answer: ragResult.answer,
      sources: this.rag.buildSources(ragResult.chunks),
      citations: this.rag.buildCitations(enrichedQuestion, ragResult.chunks),
      retrieval: ragResult.retrieval,
      grounding: ragResult.grounding,
      taskMemory: this.state.taskMemory,
      historyLength: this.state.messages.length
    };
  }

  createMessage(role, content, meta = {}) {
    return {
      role,
      content,
      meta,
      createdAt: new Date().toISOString()
    };
  }

  updateTaskMemory(userInput) {
    const text = userInput.trim();
    const lower = text.toLowerCase();

    if (/^цель:|^задача:|хочу|собираем|делаем|планирую/.test(lower)) {
      this.state.taskMemory.goal = text;
    }

    this.collectListItems("constraints", text, [
      /ограничени[ея]?:?\s*(.+)$/i,
      /нельзя\s+(.+)$/i,
      /без\s+(.+)$/i,
      /только\s+(.+)$/i,
      /важно,?\s+(.+)$/i
    ]);

    this.collectListItems("terms", text, [
      /термин:?\s*(.+)$/i,
      /называем\s+(.+)$/i,
      /под\s+(.+?)\s+понимаем\s+(.+)$/i
    ]);

    this.collectListItems("decisions", text, [
      /решение:?\s*(.+)$/i,
      /договорились:?\s*(.+)$/i,
      /фиксируем:?\s*(.+)$/i,
      /выбираем\s+(.+)$/i
    ]);

    if (/[?？]$/.test(text) || /уточн|проверь|сравни|объясни|как|какой|какая|какие/.test(lower)) {
      this.addUnique("clarifications", text);
    }
  }

  collectListItems(layer, text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        this.addUnique(layer, match[1].trim());
      }
    }
  }

  addUnique(layer, value) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (!clean) {
      return;
    }

    const values = this.state.taskMemory[layer] || [];
    if (!values.some((item) => item.toLowerCase() === clean.toLowerCase())) {
      values.push(clean);
    }
    this.state.taskMemory[layer] = values.slice(-12);
  }

  buildRagQuestion(userInput) {
    const recent = this.state.messages
      .slice(-this.recentMessages)
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    return [
      "Ответь на новый вопрос пользователя с учетом памяти задачи и истории.",
      "",
      "Память задачи:",
      this.formatTaskMemory(),
      "",
      "Недавняя история:",
      recent || "История пока пустая.",
      "",
      `Новый вопрос: ${userInput}`
    ].join("\n");
  }

  buildMemorySearchQuestion(userInput) {
    const memory = this.state.taskMemory;
    return [
      userInput,
      memory.goal,
      ...memory.constraints,
      ...memory.terms,
      ...memory.decisions,
      ...memory.clarifications.slice(-3)
    ].filter(Boolean).join("\n");
  }

  formatTaskMemory() {
    const memory = this.state.taskMemory;
    return [
      `Цель: ${memory.goal || "не зафиксирована"}`,
      `Уточнения: ${this.formatList(memory.clarifications)}`,
      `Ограничения: ${this.formatList(memory.constraints)}`,
      `Термины: ${this.formatList(memory.terms)}`,
      `Решения: ${this.formatList(memory.decisions)}`
    ].join("\n");
  }

  formatList(values = []) {
    return values.length > 0 ? values.join("; ") : "нет";
  }

  getStateSnapshot() {
    return structuredClone(this.state);
  }
}
