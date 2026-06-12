import { GigaChatAgent } from "./agent.js";

const STRATEGIES = new Set(["sliding", "facts", "branching"]);

export class ContextStrategyAgent extends GigaChatAgent {
  constructor({
    strategy = "sliding",
    windowSize = 6,
    systemPrompt = "Ты аналитик, который помогает составлять техническое задание. Отвечай кратко и учитывай переданный контекст.",
    ...options
  } = {}) {
    super({
      ...options,
      compressionEnabled: false,
      systemPrompt
    });

    this.setStrategy(strategy);
    this.windowSize = windowSize;
    this.systemPrompt = systemPrompt;
    this.messages = [];
    this.facts = {};
    this.branches = { main: [] };
    this.activeBranch = "main";
    this.checkpoints = {};
  }

  setStrategy(strategy) {
    if (!STRATEGIES.has(strategy)) {
      throw new Error(`Неизвестная стратегия "${strategy}". Используйте sliding, facts или branching.`);
    }

    this.strategy = strategy;
  }

  get activeMessages() {
    return this.strategy === "branching"
      ? this.branches[this.activeBranch]
      : this.messages;
  }

  get strategyState() {
    return {
      strategy: this.strategy,
      windowSize: this.windowSize,
      facts: { ...this.facts },
      activeBranch: this.activeBranch,
      branches: Object.fromEntries(
        Object.entries(this.branches).map(([name, messages]) => [
          name,
          messages.map((message) => ({ ...message }))
        ])
      ),
      checkpoints: Object.keys(this.checkpoints)
    };
  }

  updateFacts(userInput) {
    const labeledFacts = userInput.matchAll(
      /(?:^|[.;]\s*)([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 _-]{1,30})\s*:\s*([^.;]+)/g
    );

    for (const match of labeledFacts) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      this.facts[key] = match[2].trim();
    }

    const patterns = [
      ["цель", /цель(?: проекта)?\s+(?:—|-|:|это)\s*([^.;]+)/i],
      ["бюджет", /бюджет(?: проекта)?\s+(?:—|-|:|составляет)\s*([^.;]+)/i],
      ["срок", /срок(?: запуска| проекта)?\s+(?:—|-|:|составляет)\s*([^.;]+)/i],
      ["платформа", /платформ(?:а|ы)\s+(?:—|-|:)\s*([^.;]+)/i],
      ["база_данных", /база данных\s+(?:—|-|:)\s*([^.;]+)/i],
      ["авторизация", /авторизац(?:ия|ию)\s+(?:—|-|:|через)\s*([^.;]+)/i],
      ["ограничение", /ограничени(?:е|я)\s+(?:—|-|:)\s*([^.;]+)/i],
      ["решение", /решени(?:е|я)\s+(?:—|-|:)\s*([^.;]+)/i],
      ["предпочтение", /предпочтени(?:е|я)\s+(?:—|-|:)\s*([^.;]+)/i]
    ];

    for (const [key, pattern] of patterns) {
      const value = userInput.match(pattern)?.[1]?.trim();
      if (value) {
        this.facts[key] = value;
      }
    }
  }

  createCheckpoint(name) {
    if (this.strategy !== "branching") {
      throw new Error("Checkpoint доступен только для стратегии branching.");
    }

    this.checkpoints[name] = this.activeMessages.map((message) => ({ ...message }));
  }

  createBranch(name, checkpointName) {
    if (this.strategy !== "branching") {
      throw new Error("Ветки доступны только для стратегии branching.");
    }
    if (this.branches[name]) {
      throw new Error(`Ветка "${name}" уже существует.`);
    }

    const source = checkpointName
      ? this.checkpoints[checkpointName]
      : this.activeMessages;

    if (!source) {
      throw new Error(`Checkpoint "${checkpointName}" не найден.`);
    }

    this.branches[name] = source.map((message) => ({ ...message }));
  }

  switchBranch(name) {
    if (this.strategy !== "branching") {
      throw new Error("Переключение веток доступно только для стратегии branching.");
    }
    if (!this.branches[name]) {
      throw new Error(`Ветка "${name}" не найдена.`);
    }

    this.activeBranch = name;
  }

  buildContextMessages() {
    const messages = this.activeMessages;
    const systemContent =
      this.strategy === "facts" && Object.keys(this.facts).length > 0
        ? `${this.systemPrompt}\n\nВажные факты:\n${JSON.stringify(this.facts, null, 2)}`
        : this.systemPrompt;

    return [
      { role: "system", content: systemContent },
      ...messages.map((message) => ({ ...message }))
    ];
  }

  trimWindow() {
    if (this.strategy === "branching") {
      return;
    }

    if (this.messages.length > this.windowSize) {
      this.messages = this.messages.slice(-this.windowSize);
    }
  }

  async chat(userInput) {
    const content = userInput.trim();
    if (!content) {
      throw new Error("Сообщение не должно быть пустым.");
    }

    if (this.strategy === "facts") {
      this.updateFacts(content);
    }

    this.activeMessages.push({ role: "user", content });
    this.trimWindow();

    const requestMessages = this.buildContextMessages();
    const contextTokens = await this.countTokens(requestMessages.map((message) => message.content));

    if (contextTokens + this.maxCompletionTokens > this.contextWindow) {
      this.activeMessages.pop();
      throw new Error(
        `Контекст ${contextTokens} + резерв ${this.maxCompletionTokens} превышает окно ${this.contextWindow}.`
      );
    }

    try {
      const completion = this.mock
        ? this.createStrategyMockCompletion(requestMessages, contextTokens)
        : await this.requestCompletion(requestMessages);
      this.activeMessages.push({ role: "assistant", content: completion.answer });
      this.trimWindow();

      const answerTokens =
        completion.usage?.completion_tokens ?? (await this.countTokens([completion.answer]));
      const promptTokens = completion.usage?.prompt_tokens ?? contextTokens;
      const billedTokens = completion.usage?.total_tokens ?? promptTokens + answerTokens;
      const estimatedCostRub = this.calculateCost(billedTokens);

      this.lastMetrics = {
        currentRequestTokens: await this.countTokens([content]),
        historyTokens: contextTokens,
        answerTokens,
        billedTokens,
        estimatedCostRub,
        strategy: this.strategy,
        activeBranch: this.activeBranch
      };
      this.usageTotals.promptTokens += promptTokens;
      this.usageTotals.completionTokens += answerTokens;
      this.usageTotals.billedTokens += billedTokens;
      this.usageTotals.estimatedCostRub += estimatedCostRub;

      return completion.answer;
    } catch (error) {
      if (this.activeMessages.at(-1)?.role === "user") {
        this.activeMessages.pop();
      }
      throw error;
    }
  }

  createStrategyMockCompletion(requestMessages, contextTokens) {
    const context = requestMessages.map((message) => message.content).join("\n");
    const requestedFinal = /итог|финальн|сформируй тз|контрольн/i.test(
      requestMessages.at(-1)?.content || ""
    );
    const expectedKeys = [
      ["цель", /цель[^:\n]*[:—-]\s*([^\n.;]+)/i],
      ["бюджет", /бюджет[^:\n]*[:—-]\s*([^\n.;]+)/i],
      ["срок", /срок[^:\n]*[:—-]\s*([^\n.;]+)/i],
      ["платформа", /платформ[^:\n]*[:—-]\s*([^\n.;]+)/i],
      ["база данных", /база_данных["']?\s*:\s*["']([^"']+)|база данных[^:\n]*[:—-]\s*([^\n.;]+)/i],
      ["авторизация", /авторизац[^:\n]*[:—-]\s*([^\n.;]+)/i]
    ];
    const found = expectedKeys
      .map(([label, pattern]) => {
        const match = context.match(pattern);
        return match ? `${label}: ${match[1] || match[2]}` : null;
      })
      .filter(Boolean);
    const branchNote =
      this.strategy === "branching"
        ? ` Ветка: ${this.activeBranch}.`
        : "";
    const answer = requestedFinal
      ? `Итоговое ТЗ. Сохраненные детали: ${found.join("; ") || "важные детали не найдены"}.${branchNote}`
      : `Принято. Учту это в ТЗ.${branchNote}`;
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
