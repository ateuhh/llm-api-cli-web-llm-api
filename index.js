const authKey = process.env.GIGACHAT_AUTH_KEY;
const prompt = process.argv.slice(2).join(" ") || "Напиши одно короткое приветствие.";
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

const response = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${tokenData.access_token}`
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }]
  })
});

const data = await response.json();

if (!response.ok) {
  console.error("Ошибка API:", data.message || data);
  process.exit(1);
}

const text = data.choices?.[0]?.message?.content;

console.log(text || JSON.stringify(data, null, 2));
