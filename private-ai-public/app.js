const message = document.querySelector("#message");
const tone = document.querySelector("#tone");
const send = document.querySelector("#send");
const output = document.querySelector("#output");
const usage = document.querySelector("#usage");
const status = document.querySelector("#status");
const limits = document.querySelector("#limits");

const sessionId = crypto.randomUUID();

async function loadHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    status.textContent = data.ok ? "онлайн" : "недоступно";
    limits.textContent = `Модель: ${data.model}. API: ${data.privateMode ? "только localhost" : "доступен по сети"}.`;
  } catch {
    status.textContent = "недоступно";
    limits.textContent = "Сервис не отвечает.";
  }
}

async function ask() {
  const text = message.value.trim();

  if (!text) {
    output.textContent = "Сначала опиши ситуацию.";
    return;
  }

  send.disabled = true;
  output.textContent = "Думаю локально...";
  usage.textContent = "запрос к Ollama";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        tone: tone.value,
        sessionId
      })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Ошибка сервиса");
    }

    output.textContent = data.answer;
    usage.textContent = `${data.model}; ${data.usage.durationMs} мс; ${data.usage.promptTokens}+${data.usage.completionTokens} токенов`;
    limits.textContent = `Лимиты: ${data.limits.maxInputChars} символов, ${data.limits.maxContextMessages} сообщений контекста, ${data.limits.rateLimitPerMinute} запросов/мин.`;
  } catch (error) {
    output.textContent = error.message;
    usage.textContent = "ошибка";
  } finally {
    send.disabled = false;
  }
}

send.addEventListener("click", ask);
message.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    ask();
  }
});

loadHealth();
