export class OllamaAgent {
  constructor({
    baseUrl = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    model = process.env.OLLAMA_MODEL || "llama3.2:1b",
    systemPrompt = "Ты локальный CLI-ассистент. Отвечай полезно, кратко и по-русски."
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl}/api/tags`);

    if (!response.ok) {
      throw new Error(`Ollama API недоступен: HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.models || [];
  }

  async assertReady() {
    const models = await this.listModels();
    const hasModel = models.some((model) => model.name === this.model);

    if (!hasModel) {
      const available = models.map((model) => model.name).join(", ") || "нет скачанных моделей";
      throw new Error(
        `Модель ${this.model} не найдена. Доступные модели: ${available}. ` +
          `Скачайте ее командой: ollama pull ${this.model}`
      );
    }
  }

  async chat(userInput) {
    this.messages.push({ role: "user", content: userInput });

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        stream: false
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ошибка Ollama API: HTTP ${response.status} ${text}`);
    }

    const data = await response.json();
    const answer = data.message?.content?.trim() || "";
    this.messages.push({ role: "assistant", content: answer });

    return {
      answer,
      model: data.model || this.model,
      promptTokens: data.prompt_eval_count || 0,
      completionTokens: data.eval_count || 0,
      totalDurationMs: Math.round((data.total_duration || 0) / 1_000_000)
    };
  }

  clear() {
    this.messages = this.messages.slice(0, 1);
  }

  visibleHistory() {
    return this.messages.filter((message) => message.role !== "system");
  }
}
