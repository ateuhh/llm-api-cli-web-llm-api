import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class GigaChatAgent {
  constructor({
    authKey,
    model = "GigaChat-2",
    scope = "GIGACHAT_API_PERS",
    mock = false,
    historyPath = "./chat-history.json",
    contextWindow = 128000,
    maxCompletionTokens = 512,
    rubPerMillionTokens = 65,
    systemPrompt = "Ты полезный ассистент. Учитывай всю историю диалога и отвечай на русском языке."
  } = {}) {
    this.authKey = authKey;
    this.model = model;
    this.scope = scope;
    this.mock = mock;
    this.historyPath = historyPath;
    this.contextWindow = contextWindow;
    this.maxCompletionTokens = maxCompletionTokens;
    this.rubPerMillionTokens = rubPerMillionTokens;
    this.accessToken = null;
    this.messages = [{ role: "system", content: systemPrompt }];
    this.usageTotals = {
      promptTokens: 0,
      completionTokens: 0,
      billedTokens: 0,
      estimatedCostRub: 0
    };
    this.lastMetrics = null;
  }

  get history() {
    return this.messages.map((message) => ({ ...message }));
  }

  async loadHistory() {
    try {
      const rawHistory = await readFile(this.historyPath, "utf8");
      const savedData = JSON.parse(rawHistory);
      const savedMessages = Array.isArray(savedData) ? savedData : savedData.messages;

      if (!Array.isArray(savedMessages) || !savedMessages.every(this.isValidMessage)) {
        throw new Error("неверный формат messages");
      }

      this.messages = savedMessages;
      if (!Array.isArray(savedData) && savedData.usageTotals) {
        this.usageTotals = { ...this.usageTotals, ...savedData.usageTotals };
      }
      return this.history;
    } catch (error) {
      if (error.code === "ENOENT") {
        await this.saveHistory();
        return this.history;
      }

      if (error instanceof SyntaxError || error.message === "неверный формат messages") {
        throw new Error(`Не удалось загрузить ${this.historyPath}: поврежден JSON.`);
      }

      throw error;
    }
  }

  async saveHistory() {
    const temporaryPath = `${this.historyPath}.tmp`;
    await mkdir(dirname(this.historyPath), { recursive: true });
    const savedData = {
      messages: this.messages,
      usageTotals: this.usageTotals
    };
    await writeFile(temporaryPath, `${JSON.stringify(savedData, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.historyPath);
  }

  async clearHistory() {
    const systemMessage = this.messages.find((message) => message.role === "system");
    this.messages = systemMessage ? [{ ...systemMessage }] : [];
    this.usageTotals = {
      promptTokens: 0,
      completionTokens: 0,
      billedTokens: 0,
      estimatedCostRub: 0
    };
    this.lastMetrics = null;
    await this.saveHistory();
  }

  async chat(userInput) {
    const content = userInput.trim();

    if (!content) {
      throw new Error("Сообщение не должно быть пустым.");
    }

    this.messages.push({ role: "user", content });

    try {
      const currentRequestTokens = await this.countTokens([content]);
      const historyTokens = await this.countTokens(this.messages.map((message) => message.content));

      if (historyTokens + this.maxCompletionTokens > this.contextWindow) {
        throw new Error(
          [
            `Переполнено контекстное окно модели ${this.model}.`,
            `История: ${historyTokens} токенов, резерв ответа: ${this.maxCompletionTokens},`,
            `лимит: ${this.contextWindow}. Очистите или сократите историю.`
          ].join(" ")
        );
      }

      const completion = this.mock
        ? this.createMockCompletion(content, historyTokens)
        : await this.requestCompletion();
      const answer = completion.answer;
      this.messages.push({ role: "assistant", content: answer });
      const answerTokens =
        completion.usage?.completion_tokens ?? (await this.countTokens([answer]));
      const promptTokens = completion.usage?.prompt_tokens ?? historyTokens;
      const billedTokens = completion.usage?.total_tokens ?? promptTokens + answerTokens;
      const estimatedCostRub = this.calculateCost(billedTokens);

      this.lastMetrics = {
        currentRequestTokens,
        historyTokens,
        answerTokens,
        billedTokens,
        estimatedCostRub,
        contextWindow: this.contextWindow,
        contextUsagePercent: (historyTokens / this.contextWindow) * 100
      };
      this.usageTotals.promptTokens += promptTokens;
      this.usageTotals.completionTokens += answerTokens;
      this.usageTotals.billedTokens += billedTokens;
      this.usageTotals.estimatedCostRub += estimatedCostRub;
      await this.saveHistory();
      return answer;
    } catch (error) {
      if (this.messages.at(-1)?.role === "user") {
        this.messages.pop();
      } else {
        this.messages.splice(-2);
      }
      throw error;
    }
  }

  calculateCost(tokens) {
    return (tokens / 1_000_000) * this.rubPerMillionTokens;
  }

  async countTokens(texts) {
    if (texts.length === 0) {
      return 0;
    }

    if (this.mock) {
      return texts.reduce((sum, text) => sum + Math.max(1, Math.ceil(text.length / 3.5)), 0);
    }

    if (!this.accessToken) {
      this.accessToken = await this.requestAccessToken();
    }

    const response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/tokens/count", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Ошибка подсчета токенов: ${response.status}`);
    }

    return data.reduce((sum, item) => sum + (item.tokens ?? item.tokens_count ?? 0), 0);
  }

  isValidMessage(message) {
    return (
      message &&
      ["system", "user", "assistant"].includes(message.role) &&
      typeof message.content === "string"
    );
  }

  async requestCompletion() {
    if (!this.authKey) {
      throw new Error("Не задан GIGACHAT_AUTH_KEY.");
    }

    if (!this.accessToken) {
      this.accessToken = await this.requestAccessToken();
    }

    const response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Ошибка GigaChat API: ${response.status}`);
    }

    const answer = data.choices?.[0]?.message?.content;

    if (!answer) {
      throw new Error("LLM вернула пустой ответ.");
    }

    return { answer, usage: data.usage };
  }

  async requestAccessToken() {
    let response;

    try {
      response = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          RqUID: crypto.randomUUID(),
          Authorization: this.authKey.startsWith("Basic ") ? this.authKey : `Basic ${this.authKey}`
        },
        body: new URLSearchParams({ scope: this.scope })
      });
    } catch (error) {
      if (error.cause?.code === "SELF_SIGNED_CERT_IN_CHAIN") {
        throw new Error(
          'Node.js не доверяет сертификату НУЦ Минцифры. Запустите с NODE_EXTRA_CA_CERTS="/путь/к/сертификату.crt".'
        );
      }

      throw new Error(`Ошибка сети: ${error.message}`);
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Ошибка авторизации GigaChat: ${response.status}`);
    }

    return data.access_token;
  }

  createMockCompletion(userInput, historyTokens) {
    const previousUserMessages = this.messages
      .filter((message) => message.role === "user")
      .slice(0, -1)
      .map((message) => message.content);

    if (previousUserMessages.length === 0) {
      const answer = `Я запомнил ваш первый запрос: "${userInput}". Задайте уточняющий вопрос, и я использую этот контекст.`;
      return {
        answer,
        usage: {
          prompt_tokens: historyTokens,
          completion_tokens: Math.ceil(answer.length / 3.5),
          total_tokens: historyTokens + Math.ceil(answer.length / 3.5)
        }
      };
    }

    const previous = previousUserMessages.at(-1);
    const answer = [
      `Продолжаю диалог с учетом истории.`,
      `Предыдущий запрос: "${previous}".`,
      `Новый запрос: "${userInput}".`,
      `В реальном режиме эта полная история отправляется в GigaChat API.`
    ].join(" ");
    const answerTokens = Math.ceil(answer.length / 3.5);
    return {
      answer,
      usage: {
        prompt_tokens: historyTokens,
        completion_tokens: answerTokens,
        total_tokens: historyTokens + answerTokens
      }
    };
  }
}
