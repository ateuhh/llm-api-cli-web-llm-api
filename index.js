const args = process.argv.slice(2);
const useMock = args.includes("--mock");
const customTask = args.filter((arg) => arg !== "--mock").join(" ");
const authKey = process.env.GIGACHAT_AUTH_KEY;
const model = process.env.GIGACHAT_MODEL || "GigaChat-2";
const scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

const task =
  customTask ||
  "Улитка находится на дне колодца глубиной 10 метров. Днем она поднимается на 3 метра, ночью сползает на 2 метра. За сколько дней улитка выберется из колодца?";

const correctAnswer = "8 дней";

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
  const generatedPrompt = [
    "Реши логическую задачу про улитку. Учитывай, что после последнего дневного подъема",
    "улитка выбирается из колодца и ночью уже не сползает. Дай краткий расчет и итог в днях."
  ].join(" ");

  return {
    direct:
      "Улитка каждый день в среднем поднимается на 1 метр, поэтому на 10 метров ей понадобится 10 дней.",
    stepByStep: [
      "День 1: поднялась до 3 м, ночью сползла до 2 м.",
      "Каждые полные сутки до последнего дня дают +1 м.",
      "К началу 8-го дня улитка будет на 7 м.",
      "Днем 8-го дня она поднимется на 3 м и достигнет 10 м.",
      "Ответ: 8 дней."
    ].join("\n"),
    generatedPrompt,
    promptBased: [
      "Нужно не считать последний ночной спуск.",
      "После 7 суток улитка окажется на высоте 7 м.",
      "На 8-й день она поднимется еще на 3 м и выберется.",
      "Ответ: 8 дней."
    ].join("\n"),
    experts: [
      "Аналитик: средний прирост 1 м в сутки применим только до последнего дня. К утру 8-го дня будет 7 м, днем достигнет 10 м.",
      "Инженер: после каждой ночи высота растет на 1 м: 1, 2, 3, 4, 5, 6, 7. На 8-й день подъем с 7 до 10 м завершает задачу.",
      "Критик: ответ 10 дней ошибочен, потому что учитывает ночной спуск после выхода. Корректный итог: 8 дней."
    ].join("\n")
  };
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

async function askGigaChat(accessToken, messages) {
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
        messages
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

  const direct = await askGigaChat(accessToken, [{ role: "user", content: task }]);

  const stepByStep = await askGigaChat(accessToken, [
    {
      role: "user",
      content: `${task}\n\nРешай пошагово.`
    }
  ]);

  const generatedPrompt = await askGigaChat(accessToken, [
    {
      role: "user",
      content: [
        "Составь лучший промпт для решения этой логической задачи.",
        "Промпт должен заставить модель учесть все условия и избежать типичной ошибки.",
        "Верни только текст промпта.",
        "",
        `Задача: ${task}`
      ].join("\n")
    }
  ]);

  const promptBased = await askGigaChat(accessToken, [{ role: "user", content: generatedPrompt }]);

  const experts = await askGigaChat(accessToken, [
    {
      role: "user",
      content: [
        `Задача: ${task}`,
        "",
        "Создай группу экспертов: аналитик, инженер, критик.",
        "Пусть каждый эксперт решит задачу своим способом.",
        "В конце дай общий вывод и финальный ответ."
      ].join("\n")
    }
  ]);

  return { direct, stepByStep, generatedPrompt, promptBased, experts };
}

const answers = useMock ? buildMockAnswers() : await runWithApi();

console.log("Задача:");
console.log(task);
console.log(`\nПроверяемый правильный ответ: ${correctAnswer}`);

printSection("1. Прямой ответ без дополнительных инструкций", answers.direct);
printSection('2. Инструкция "решай пошагово"', answers.stepByStep);
printSection("3. Сначала модель составляет промпт", answers.generatedPrompt);
printSection("3. Решение по промпту, составленному моделью", answers.promptBased);
printSection("4. Группа экспертов", answers.experts);

printSection(
  "Сравнение",
  [
    "Прямой ответ может быть короче, но чаще рискует ошибиться в нюансе последнего дня.",
    'Инструкция "решай пошагово" повышает шанс правильного расчета, потому что модель явно проверяет ход решения.',
    "Промпт, составленный моделью, обычно лучше фиксирует важное условие: после выхода улитка уже не сползает.",
    "Группа экспертов дает самую надежную проверку, потому что критик отдельно ищет типичную ошибку.",
    `Наиболее точный способ для этой задачи: группа экспертов или пошаговое решение. Ожидаемый итог: ${correctAnswer}.`
  ].join("\n")
);
