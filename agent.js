export class GigaChatAgent {
  constructor({
    authKey,
    model = "GigaChat-2",
    scope = "GIGACHAT_API_PERS",
    mock = false,
    systemPrompt = "Ты полезный ассистент. Учитывай всю историю диалога и отвечай на русском языке."
  } = {}) {
    this.authKey = authKey;
    this.model = model;
    this.scope = scope;
    this.mock = mock;
    this.accessToken = null;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  get history() {
    return this.messages.map((message) => ({ ...message }));
  }

  clearHistory() {
    const systemMessage = this.messages.find((message) => message.role === "system");
    this.messages = systemMessage ? [{ ...systemMessage }] : [];
  }

  async chat(userInput) {
    const content = userInput.trim();

    if (!content) {
      throw new Error("Сообщение не должно быть пустым.");
    }

    this.messages.push({ role: "user", content });

    try {
      const answer = this.mock ? this.createMockReply(content) : await this.requestCompletion();
      this.messages.push({ role: "assistant", content: answer });
      return answer;
    } catch (error) {
      this.messages.pop();
      throw error;
    }
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

    return answer;
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

  createMockReply(userInput) {
    const previousUserMessages = this.messages
      .filter((message) => message.role === "user")
      .slice(0, -1)
      .map((message) => message.content);

    if (previousUserMessages.length === 0) {
      return `Я запомнил ваш первый запрос: "${userInput}". Задайте уточняющий вопрос, и я использую этот контекст.`;
    }

    const previous = previousUserMessages.at(-1);
    return [
      `Продолжаю диалог с учетом истории.`,
      `Предыдущий запрос: "${previous}".`,
      `Новый запрос: "${userInput}".`,
      `В реальном режиме эта полная история отправляется в GigaChat API.`
    ].join(" ");
  }
}
