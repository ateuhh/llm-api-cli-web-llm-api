import { LayeredMemoryAgent } from "./layered-memory-agent.js";

async function createPersonalizedAgent(name, userProfile, preferences) {
  const agent = new LayeredMemoryAgent({
    mock: true,
    memoryPath: `/tmp/personalization-${name}-${crypto.randomUUID()}.json`,
    shortTermLimit: 4
  });
  await agent.loadMemory();
  await agent.setUserProfile(userProfile);
  await agent.setPreferences(preferences);
  await agent.remember("working", "goal", "Объяснить, как устроена компрессия истории агента.");
  return agent;
}

const backendStudent = await createPersonalizedAgent(
  "backend",
  {
    name: "Михаил",
    role: "начинающий backend-разработчик",
    level: "junior",
    goal: "быстро собрать рабочий пет-проект"
  },
  {
    style: "простыми словами, практично",
    format: "короткие шаги и пример команды",
    limitations: "без сложной теории и длинных абзацев"
  }
);

const productManager = await createPersonalizedAgent(
  "product",
  {
    name: "Анна",
    role: "product manager",
    level: "middle",
    goal: "оценить пользу функции для пользователя"
  },
  {
    style: "деловой, через пользу и риски",
    format: "таблица критериев и краткий вывод",
    limitations: "без кода, максимум конкретики"
  }
);

const request = "Персонализируй объяснение: зачем агенту компрессия истории?";

console.log("=== Профиль 1: начинающий backend-разработчик ===");
console.log(JSON.stringify(backendStudent.snapshot().long, null, 2));
console.log(await backendStudent.chat(request));

console.log("\n=== Профиль 2: product manager ===");
console.log(JSON.stringify(productManager.snapshot().long, null, 2));
console.log(await productManager.chat(request));

console.log("\n=== Вывод ===");
console.log("Один и тот же запрос адаптируется под userProfile и preferences из долговременной памяти.");
console.log("Профиль подключается автоматически: пользователь не повторяет стиль и формат в каждом сообщении.");
