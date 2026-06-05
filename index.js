const args = process.argv.slice(2);
const useMock = args.includes("--mock");
const customPrompt = args.filter((arg) => arg !== "--mock").join(" ");
const authKey = process.env.GIGACHAT_AUTH_KEY;
const scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

const prompt =
  customPrompt ||
  "Объясни простыми словами, почему для пет-проекта с LLM API важно сравнивать слабую, среднюю и сильную модель. Ответь в 4-5 предложениях.";

const models = [
  {
    label: "слабая модель",
    name: "GigaChat-2",
    paidRubPer1000Tokens: 0.065,
    description: "Lite: быстрая и легкая модель для простых повседневных задач"
  },
  {
    label: "средняя модель",
    name: "GigaChat-2-Pro",
    paidRubPer1000Tokens: 0.5,
    description: "Pro: усовершенствованная модель для ресурсоемких задач"
  },
  {
    label: "сильная модель",
    name: "GigaChat-2-Max",
    paidRubPer1000Tokens: 0.65,
    description: "Max: мощная модель для самых сложных и масштабных задач"
  }
];

if (!useMock && !authKey) {
  console.error("Ошибка: задайте переменную окружения GIGACHAT_AUTH_KEY или запустите демо с --mock.");
  console.error('Пример API: GIGACHAT_AUTH_KEY="ваш_ключ_авторизации" npm run ask');
  console.error("Пример демо без ключа: npm run ask -- --mock");
  process.exit(1);
}

function printSection(title, text) {
  console.log(`\n=== ${title} ===`);
  console.log(String(text).trim());
}

function rubles(value) {
  return `${value.toFixed(6)} ₽`;
}

function calculatePaidCost(totalTokens, rubPer1000Tokens) {
  return (totalTokens / 1000) * rubPer1000Tokens;
}

function buildMockResults() {
  return [
    {
      ...models[0],
      elapsedMs: 820,
      usage: { prompt_tokens: 39, completion_tokens: 62, total_tokens: 101 },
      answer:
        "Сравнивать модели важно, потому что простая модель часто отвечает быстрее и дешевле. Для пет-проекта этого может быть достаточно, если задача простая. Более сильные модели нужны, когда требуется точность, сложное рассуждение или аккуратный стиль. Так можно не переплачивать за задачи, где хватает легкой модели."
    },
    {
      ...models[1],
      elapsedMs: 1420,
      usage: { prompt_tokens: 39, completion_tokens: 82, total_tokens: 121 },
      answer:
        "Для пет-проекта сравнение моделей помогает найти баланс между качеством, скоростью и стоимостью. Слабая модель подходит для простых ответов и черновиков, средняя лучше справляется с объяснениями и структурой, а сильная полезна для сложной логики и более надежных выводов. Если проверять только одну модель, легко выбрать слишком дорогой или слишком слабый вариант. Поэтому тест на одном запросе показывает, где качество действительно оправдывает ресурсы."
    },
    {
      ...models[2],
      elapsedMs: 2380,
      usage: { prompt_tokens: 39, completion_tokens: 103, total_tokens: 142 },
      answer:
        "Сравнение слабой, средней и сильной модели позволяет понять, какая из них дает достаточное качество именно для вашего сценария. В пет-проекте это особенно важно: бюджет и лимиты обычно ограничены, поэтому сильную модель стоит использовать только там, где она заметно улучшает результат. Легкая модель часто выигрывает по скорости и цене, но может хуже держать контекст или упрощать рассуждения. Средняя модель обычно становится практичным компромиссом, а сильная нужна для задач с высокой ценой ошибки, сложной аналитикой или требованием к стабильному качеству."
    }
  ];
}

async function getAccessToken() {
  let tokenResponse;

  try {
    tokenResponse = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        RqUID: crypto.randomUUID(),
        Authorization: authKey.startsWith("Basic ") ? authKey : `Basic ${authKey}`
      },
      body: new URLSearchParams({ scope })
    });
  } catch (error) {
    if (error.cause?.code === "SELF_SIGNED_CERT_IN_CHAIN") {
      console.error("Ошибка TLS: Node.js не доверяет сертификату НУЦ Минцифры.");
      console.error("Скачайте корневой сертификат и запустите команду с NODE_EXTRA_CA_CERTS.");
      console.error("Пример:");
      console.error('NODE_EXTRA_CA_CERTS="/путь/russian_trusted_root_ca_pem.crt" npm run ask');
    } else {
      console.error("Ошибка сети:", error.message);
    }

    process.exit(1);
  }

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok) {
    console.error("Ошибка получения токена:", tokenData.message || tokenData);
    process.exit(1);
  }

  return tokenData.access_token;
}

async function askGigaChat(accessToken, modelConfig) {
  let response;
  const startedAt = performance.now();

  try {
    response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        model: modelConfig.name,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (error) {
    console.error("Ошибка сети:", error.message);
    process.exit(1);
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  const data = await response.json();

  if (!response.ok) {
    console.error(`Ошибка API для ${modelConfig.name}:`, data.message || data);
    process.exit(1);
  }

  return {
    ...modelConfig,
    elapsedMs,
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    answer: data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2)
  };
}

async function runWithApi() {
  const accessToken = await getAccessToken();
  const results = [];

  for (const modelConfig of models) {
    results.push(await askGigaChat(accessToken, modelConfig));
  }

  return results;
}

function renderResult(result) {
  const paidCost = calculatePaidCost(result.usage.total_tokens, result.paidRubPer1000Tokens);

  return [
    `Модель: ${result.name}`,
    `Описание: ${result.description}`,
    `Время ответа: ${result.elapsedMs} мс`,
    `Токены: prompt=${result.usage.prompt_tokens}, completion=${result.usage.completion_tokens}, total=${result.usage.total_tokens}`,
    `Стоимость: 0 ₽ в рамках freemium-лимита; платная оценка: ${rubles(paidCost)} при ${result.paidRubPer1000Tokens} ₽ / 1000 токенов`,
    "",
    result.answer
  ].join("\n");
}

const results = useMock ? buildMockResults() : await runWithApi();

console.log("Запрос:");
console.log(prompt);

for (const result of results) {
  printSection(`${result.label}: ${result.name}`, renderResult(result));
}

printSection(
  "Сравнение",
  [
    "Качество: слабая модель обычно достаточна для простых объяснений; средняя дает более полную структуру; сильная лучше раскрывает нюансы и риски.",
    "Скорость: слабая модель чаще быстрее, сильная обычно медленнее из-за большей ресурсоемкости.",
    "Ресурсоемкость: сильная модель чаще генерирует больше токенов и дороже в платном режиме; слабая экономнее.",
    "Практический вывод: начинайте с GigaChat-2, переходите на GigaChat-2-Pro для устойчивого качества, используйте GigaChat-2-Max для сложной аналитики и задач с высокой ценой ошибки."
  ].join("\n")
);

printSection(
  "Ссылки",
  [
    "Модели GigaChat: https://developers.sber.ru/docs/ru/gigachat/models",
    "Выбор модели: https://developers.sber.ru/docs/ru/gigachat/guides/selecting-a-model",
    "Подсчет токенов и usage: https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens",
    "Тарифы для физлиц: https://developers.sber.ru/docs/ru/gigachat/tariffs/individual-tariffs"
  ].join("\n")
);
