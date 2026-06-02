const authKey = process.env.GIGACHAT_AUTH_KEY;
const prompt = process.argv.slice(2).join(" ") || "Объясни, что такое API, одним предложением.";
const model = process.env.GIGACHAT_MODEL || "GigaChat-2";
const scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

if (!authKey) {
  console.error("Ошибка: задайте переменную окружения GIGACHAT_AUTH_KEY.");
  console.error('Пример: GIGACHAT_AUTH_KEY="ваш_ключ_авторизации" npm run ask -- "Привет!"');
  process.exit(1);
}

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
    console.error('NODE_EXTRA_CA_CERTS="/путь/russian_trusted_root_ca_pem.crt" npm run ask -- "Привет"');
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

async function askGigaChat({ messages, maxTokens, stop }) {
  let response;

  try {
    response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${tokenData.access_token}`
      },
      body: JSON.stringify({
        model,
        messages,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(stop ? { stop } : {})
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

const uncontrolledAnswer = await askGigaChat({
  messages: [{ role: "user", content: prompt }]
});

const controlledAnswer = await askGigaChat({
  messages: [
    {
      role: "user",
      content: [
        prompt,
        "",
        "Ответь строго в формате JSON:",
        '{"answer":"короткий ответ","key_points":["пункт 1","пункт 2"]}',
        "Ограничение: не больше 2 коротких пунктов в key_points.",
        "Когда закончишь ответ, напиши ###END###."
      ].join("\n")
    }
  ],
  maxTokens: 120,
  stop: ["###END###"]
});

console.log("Запрос:");
console.log(prompt);
console.log("\n=== Ответ без ограничений ===");
console.log(uncontrolledAnswer);
console.log("\n=== Ответ с ограничениями ===");
console.log(controlledAnswer.trim());
