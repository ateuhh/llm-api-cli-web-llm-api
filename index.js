const args = process.argv.slice(2);
const useMock = args.includes("--mock");
const customPrompt = args.filter((arg) => arg !== "--mock").join(" ");
const authKey = process.env.GIGACHAT_AUTH_KEY;
const model = process.env.GIGACHAT_MODEL || "GigaChat-2";
const scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

const prompt =
  customPrompt ||
  "Объясни, что такое API, простыми словами и придумай одну бытовую аналогию. Ответь в 3-4 предложениях.";

const temperatures = [0, 0.7, 1.2];

if (!useMock && !authKey) {
  console.error("Ошибка: задайте переменную окружения GIGACHAT_AUTH_KEY или запустите демо с --mock.");
  console.error('Пример API: GIGACHAT_AUTH_KEY="ваш_ключ_авторизации" npm run ask');
  console.error("Пример демо без ключа: npm run ask -- --mock");
  process.exit(1);
}

function printSection(title, text) {
  console.log(`\n=== ${title} ===`);
  console.log(text.trim());
}

function buildMockAnswers() {
  return [
    {
      temperature: 0,
      answer: [
        "API — это набор правил, по которым одна программа обращается к другой и получает от нее данные или действие.",
        "Например, приложение погоды через API запрашивает прогноз у сервера.",
        "Бытовая аналогия: API похож на меню в кафе — вы выбираете понятный пункт, а кухня выполняет заказ по своим внутренним правилам."
      ].join(" ")
    },
    {
      temperature: 0.7,
      answer: [
        "API — это способ для программ разговаривать друг с другом без знания всех внутренних деталей.",
        "Если сайт просит банк проверить платеж или карту показать маршрут, это часто происходит через API.",
        "В быту API похож на окно выдачи в библиотеке: вы называете, что нужно, а сотрудник приносит результат из системы, куда вы сами не заходите."
      ].join(" ")
    },
    {
      temperature: 1.2,
      answer: [
        "API — это как вежливый переводчик между программами: одна говорит, что ей нужно, другая возвращает результат в понятном формате.",
        "Представьте домофон: вы нажимаете кнопку квартиры, система передает запрос, а человек внутри решает, открыть дверь или нет.",
        "Так и приложение не лезет внутрь чужого сервиса, а обращается через заранее оговоренный вход."
      ].join(" ")
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

async function askGigaChat(accessToken, temperature) {
  let response;

  try {
    response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (error) {
    console.error("Ошибка сети:", error.message);
    process.exit(1);
  }

  const data = await response.json();

  if (!response.ok) {
    console.error("Ошибка API:", data.message || data);
    process.exit(1);
  }

  return data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
}

async function runWithApi() {
  const accessToken = await getAccessToken();
  const answers = [];

  for (const temperature of temperatures) {
    const answer = await askGigaChat(accessToken, temperature);
    answers.push({ temperature, answer });
  }

  return answers;
}

const answers = useMock ? buildMockAnswers() : await runWithApi();

console.log("Запрос:");
console.log(prompt);

for (const { temperature, answer } of answers) {
  printSection(`temperature = ${temperature}`, answer);
}

printSection(
  "Сравнение",
  [
    "temperature = 0: обычно самый точный и предсказуемый ответ. Формулировки сухие, разнообразие минимальное.",
    "temperature = 0.7: баланс точности и живости. Ответ остается по теме, но аналогии и стиль становятся менее шаблонными.",
    "temperature = 1.2: больше креативности и разнообразия, но выше риск лишних деталей, неточностей или слишком свободной аналогии."
  ].join("\n")
);

printSection(
  "Для каких задач подходит",
  [
    "temperature = 0: фактические ответы, инструкции, классификация, извлечение данных, код, где важна повторяемость.",
    "temperature = 0.7: объяснения, учебные примеры, тексты для пользователей, идеи с умеренной вариативностью.",
    "temperature = 1.2: брейншторминг, креативные названия, необычные аналогии, черновики рекламных или художественных текстов."
  ].join("\n")
);
