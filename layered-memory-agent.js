import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GigaChatAgent } from "./agent.js";

const MEMORY_LAYERS = new Set(["short", "working", "long"]);

export class LayeredMemoryAgent extends GigaChatAgent {
  constructor({
    memoryPath = "./memory-layers.json",
    shortTermLimit = 8,
    systemPrompt = "Ты ассистент с явной моделью памяти. Используй только переданные слои памяти и текущий запрос.",
    ...options
  } = {}) {
    super({
      ...options,
      compressionEnabled: false,
      systemPrompt
    });

    this.memoryPath = memoryPath;
    this.shortTermLimit = shortTermLimit;
    this.systemPrompt = systemPrompt;
    this.memory = {
      short: [],
      working: {},
      long: {}
    };
  }

  async loadMemory() {
    try {
      const rawMemory = await readFile(this.memoryPath, "utf8");
      const savedMemory = JSON.parse(rawMemory);
      this.memory = {
        short: Array.isArray(savedMemory.short) ? savedMemory.short : [],
        working: savedMemory.working && typeof savedMemory.working === "object" ? savedMemory.working : {},
        long: savedMemory.long && typeof savedMemory.long === "object" ? savedMemory.long : {}
      };
      return this.snapshot();
    } catch (error) {
      if (error.code === "ENOENT") {
        await this.saveMemory();
        return this.snapshot();
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Не удалось загрузить ${this.memoryPath}: поврежден JSON.`);
      }

      throw error;
    }
  }

  async saveMemory() {
    const temporaryPath = `${this.memoryPath}.tmp`;
    await mkdir(dirname(this.memoryPath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(this.memory, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.memoryPath);
  }

  snapshot() {
    return {
      short: this.memory.short.map((message) => ({ ...message })),
      working: { ...this.memory.working },
      long: { ...this.memory.long }
    };
  }

  async remember(layer, key, value) {
    if (!MEMORY_LAYERS.has(layer)) {
      throw new Error("Слой памяти должен быть short, working или long.");
    }

    if (layer === "short") {
      this.addShortMessage({ role: key, content: value });
    } else {
      this.memory[layer][key] = value;
    }

    await this.saveMemory();
  }

  async forget(layer, key) {
    if (!MEMORY_LAYERS.has(layer)) {
      throw new Error("Слой памяти должен быть short, working или long.");
    }

    if (layer === "short") {
      this.memory.short = [];
    } else {
      delete this.memory[layer][key];
    }

    await this.saveMemory();
  }

  async clearMemory() {
    this.memory = { short: [], working: {}, long: {} };
    this.usageTotals = {
      promptTokens: 0,
      completionTokens: 0,
      billedTokens: 0,
      estimatedCostRub: 0
    };
    await this.saveMemory();
  }

  addShortMessage(message) {
    this.memory.short.push(message);

    if (this.memory.short.length > this.shortTermLimit) {
      this.memory.short = this.memory.short.slice(-this.shortTermLimit);
    }
  }

  buildMemoryPrompt() {
    return [
      this.systemPrompt,
      "",
      "Долговременная память: профиль, устойчивые предпочтения, решения и знания.",
      JSON.stringify(this.memory.long, null, 2),
      "",
      "Рабочая память: данные текущей задачи, временные требования и ограничения.",
      JSON.stringify(this.memory.working, null, 2),
      "",
      "Краткосрочная память: последние сообщения текущего диалога.",
      JSON.stringify(this.memory.short, null, 2)
    ].join("\n");
  }

  async chat(userInput) {
    const content = userInput.trim();

    if (!content) {
      throw new Error("Сообщение не должно быть пустым.");
    }

    const requestMessages = [
      { role: "system", content: this.buildMemoryPrompt() },
      { role: "user", content }
    ];
    const contextTokens = await this.countTokens(requestMessages.map((message) => message.content));

    const completion = this.mock
      ? this.createLayeredMemoryMockCompletion(content, contextTokens)
      : await this.requestCompletion(requestMessages);
    const answer = completion.answer;

    this.addShortMessage({ role: "user", content });
    this.addShortMessage({ role: "assistant", content: answer });

    const answerTokens =
      completion.usage?.completion_tokens ?? (await this.countTokens([answer]));
    const promptTokens = completion.usage?.prompt_tokens ?? contextTokens;
    const billedTokens = completion.usage?.total_tokens ?? promptTokens + answerTokens;
    const estimatedCostRub = this.calculateCost(billedTokens);

    this.lastMetrics = {
      currentRequestTokens: await this.countTokens([content]),
      historyTokens: contextTokens,
      answerTokens,
      billedTokens,
      estimatedCostRub,
      shortMessages: this.memory.short.length,
      workingKeys: Object.keys(this.memory.working).length,
      longKeys: Object.keys(this.memory.long).length
    };
    this.usageTotals.promptTokens += promptTokens;
    this.usageTotals.completionTokens += answerTokens;
    this.usageTotals.billedTokens += billedTokens;
    this.usageTotals.estimatedCostRub += estimatedCostRub;
    await this.saveMemory();

    return answer;
  }

  createLayeredMemoryMockCompletion(userInput, contextTokens) {
    const wantsMemory =
      /что ты помнишь|памят|какие данные|слои/i.test(userInput);
    const wantsPlan =
      /план|рекомендац|как отвечать|сформируй/i.test(userInput);
    const answer = wantsMemory
      ? [
          `Краткосрочная память: ${this.memory.short.length} сообщений.`,
          `Рабочая память: ${Object.keys(this.memory.working).join(", ") || "пусто"}.`,
          `Долговременная память: ${Object.keys(this.memory.long).join(", ") || "пусто"}.`
        ].join(" ")
      : wantsPlan
        ? [
            `Учитываю профиль: ${this.memory.long.profile || this.memory.long.style || "нет профиля"}.`,
            `Текущая задача: ${this.memory.working.goal || this.memory.working.task || "не указана"}.`,
            `Ограничения: ${this.memory.working.constraints || "не указаны"}.`
          ].join(" ")
        : "Принято. Я использую краткосрочную, рабочую и долговременную память раздельно.";
    const completionTokens = Math.ceil(answer.length / 3.5);

    return {
      answer,
      usage: {
        prompt_tokens: contextTokens,
        completion_tokens: completionTokens,
        total_tokens: contextTokens + completionTokens
      }
    };
  }
}
