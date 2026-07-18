import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GigaChatAgent } from "./agent.js";

const DEFAULT_OUTPUT = "epic-decomposition.md";

function parseArgs(argv) {
  const args = {
    inputPath: "",
    outputPath: DEFAULT_OUTPUT,
    mock: argv.includes("--mock")
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input" && next) {
      args.inputPath = next;
      index += 1;
    } else if (arg === "--output" && next) {
      args.outputPath = next;
      index += 1;
    }
  }

  return args;
}

async function readMultilineInput() {
  const cli = createInterface({ input, output });
  const lines = [];

  console.log("Вставьте бизнес-постановку и описание макетов.");
  console.log("Когда закончите, введите строку: /done");

  for await (const line of cli) {
    if (line.trim() === "/done") {
      break;
    }
    lines.push(line);
  }

  cli.close();
  return lines.join("\n").trim();
}

class FutureIntegrationContext {
  constructor({
    projectDocs = null,
    figma = null,
    jira = null,
    team = null
  } = {}) {
    this.projectDocs = projectDocs;
    this.figma = figma;
    this.jira = jira;
    this.team = team;
  }

  static defaults() {
    return new FutureIntegrationContext({
      projectDocs: {
        status: "not_connected",
        assumption: "Внутреннее устройство проектов неизвестно. Декомпозиция строится по универсальной схеме web/backend/mobile."
      },
      figma: {
        status: "not_connected",
        assumption: "Макеты описаны словами. Будущая интеграция сможет подтягивать экраны, состояния и компоненты из Figma."
      },
      jira: {
        status: "not_connected",
        assumption: "Задачи пока формируются как Markdown. Будущая интеграция сможет заводить epic/story/task в Jira."
      },
      team: {
        status: "default",
        assumption: "Все разработчики считаются senior, если пользователь не указал иное."
      }
    });
  }

  toPromptBlock() {
    return JSON.stringify({
      projectDocs: this.projectDocs,
      figma: this.figma,
      jira: this.jira,
      team: this.team
    }, null, 2);
  }
}

class EpicDecomposer {
  constructor({
    mock = false,
    authKey = process.env.GIGACHAT_AUTH_KEY,
    model = process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
    integrations = FutureIntegrationContext.defaults()
  } = {}) {
    this.mock = mock;
    this.integrations = integrations;
    this.llm = new GigaChatAgent({
      authKey,
      model,
      scope,
      mock,
      compressionEnabled: false,
      historyPath: `/tmp/epic-decomposer-${crypto.randomUUID()}.json`,
      maxCompletionTokens: 2200,
      systemPrompt: "Ты senior delivery analyst и tech lead, который декомпозирует продуктовые эпики для команд разработки."
    });
  }

  async decompose(rawTask) {
    const task = rawTask.trim();

    if (!task) {
      throw new Error("Постановка задачи не должна быть пустой.");
    }

    if (this.mock || !process.env.GIGACHAT_AUTH_KEY) {
      return this.mockDecomposition(task);
    }

    const prompt = this.buildPrompt(task);

    try {
      const completion = await this.llm.requestCompletion(
        [
          {
            role: "system",
            content: [
              "Ты декомпозируешь бизнес-постановку в задачи разработки.",
              "Отвечай по-русски.",
              "Думай как техлид, backend lead, frontend lead, iOS lead, Android lead и QA lead.",
              "Декомпозиция должна быть удобна для разработки, тестирования и слияния в ветку эпика.",
              "Не выдумывай внутренние детали проекта. Если данных не хватает, явно пометь как допущение.",
              "Не создавай Jira issue id, потому что Jira еще не подключена."
            ].join(" ")
          },
          { role: "user", content: prompt }
        ],
        2200
      );
      return this.ensureRequiredSections(completion.answer, task);
    } catch (error) {
      return [
        "# Декомпозиция Эпика",
        "",
        `GigaChat API недоступен: ${error.message}`,
        "",
        this.mockDecomposition(task)
      ].join("\n");
    }
  }

  buildPrompt(task) {
    return [
      "Нужно декомпозировать реальную бизнес-постановку в задачи разработки.",
      "",
      "Входная постановка:",
      task,
      "",
      "Доступные интеграции и ограничения:",
      this.integrations.toPromptBlock(),
      "",
      "Требования к результату:",
      "- Сначала коротко сформулируй цель эпика и границы.",
      "- Отдельно выпиши вопросы и недостающие данные.",
      "- Разбей задачи по ролям: Backend, Frontend Web, iOS, Android, QA/Analytics, Release/DevOps если нужно.",
      "- Каждая задача должна быть маленькой, проверяемой и пригодной для отдельного PR.",
      "- Для каждой задачи укажи: цель, входные зависимости, критерии готовности, как тестировать, можно ли слить без QA.",
      "- Выдели порядок работ и блокировки между ролями.",
      "- Укажи future integrations: какие данные подтянуть из внутренних docs, Figma и Jira, когда они появятся.",
      "- Верни Markdown."
    ].join("\n");
  }

  ensureRequiredSections(answer, task) {
    const required = ["Backend", "Frontend", "iOS", "Android"];
    const missing = required.filter((section) => !new RegExp(section, "i").test(answer));

    if (missing.length === 0) {
      return answer.trim();
    }

    return [
      answer.trim(),
      "",
      "## Проверка Полноты",
      "",
      `Постановка: ${this.firstLine(task)}`,
      `Не найдены явные секции: ${missing.join(", ")}. Перед переносом в Jira проверьте, нужны ли эти направления для эпика.`
    ].join("\n");
  }

  mockDecomposition(task) {
    const title = this.deriveTitle(task);
    const featureArea = this.detectArea(task);
    const mobileExplicitlyNotRequired =
      /мобильн[а-яёa-z]*[^.\n]{0,100}(пока\s+)?не\s+обязательн/i.test(task) ||
      /ios\s+и\s+android[^.\n]{0,120}(пока\s+)?не\s+входят/i.test(task) ||
      /ios\s+и\s+android[^.\n]{0,120}будущ/i.test(task);
    const needsMobile = !mobileExplicitlyNotRequired &&
      /ios|android|мобил|приложен|экран|push|пуш|смартфон/i.test(task);
    const needsBackend = !/только\s+ui|только\s+frontend/i.test(task);

    return [
      "# Декомпозиция Эпика",
      "",
      `## Цель`,
      "",
      `Реализовать: ${title}.`,
      "",
      "## Допущения",
      "",
      "- Внутреннее устройство проектов пока не подключено.",
      "- Figma пока недоступна, макеты считаются описанными текстом.",
      "- Jira пока недоступна, задачи сформированы в Markdown.",
      "- Уровень разработчиков: senior.",
      "",
      "## Вопросы До Стартa",
      "",
      "- Какие точные состояния экранов есть в макетах: loading, empty, error, success?",
      "- Нужны ли feature flags и постепенное включение?",
      "- Есть ли обратная совместимость API для старых мобильных версий?",
      "- Какие аналитические события нужно отправлять?",
      "",
      "## Порядок Работ",
      "",
      "1. Уточнить контракт API и состояния UI.",
      "2. Подготовить backend-контракт или mock contract.",
      "3. Реализовать frontend/mobile независимо от backend через mock/stub, если контракт утвержден.",
      "4. Подключить реальные API.",
      "5. Провести интеграционную проверку и подготовить release notes.",
      "",
      "## Backend",
      "",
      needsBackend
        ? this.taskBlock({
            title: `Подготовить API-контракт для ${featureArea}`,
            goal: "Описать request/response, ошибки, права доступа и миграции данных.",
            dependencies: "Бизнес-правила и список состояний из макетов.",
            testing: "Unit-тесты на валидацию, contract tests, проверка ошибок.",
            merge: "Можно слить без ручного QA, если это только контракт/OpenAPI без runtime-логики."
          })
        : "- Backend-задачи не требуются по текущей постановке.",
      "",
      needsBackend
        ? this.taskBlock({
            title: `Реализовать backend-логику для ${featureArea}`,
            goal: "Добавить endpoint/service/use-case и обработку бизнес-правил.",
            dependencies: "Утвержденный API-контракт.",
            testing: "Unit + integration tests, проверка прав доступа и негативных сценариев.",
            merge: "Требуется QA или интеграционная проверка, если меняется runtime-поведение."
          })
        : "",
      "",
      "## Frontend Web",
      "",
      this.taskBlock({
        title: `Собрать UI-состояния для ${featureArea}`,
        goal: "Реализовать экран/компонент по словесному описанию макетов.",
        dependencies: "Список состояний, тексты, роли пользователя, API contract или mock data.",
        testing: "Storybook/скриншотная проверка или ручная проверка состояний.",
        merge: "Можно слить в ветку эпика без QA, если компонент изолирован и работает на mock data."
      }),
      "",
      this.taskBlock({
        title: `Подключить web UI к данным`,
        goal: "Интегрировать UI с API, обработать loading/error/empty/success.",
        dependencies: "Готовый backend endpoint или stable mock server.",
        testing: "Интеграционный smoke, проверка ошибок сети, проверка прав.",
        merge: "Требуется QA, если пользовательский сценарий становится доступен в продукте."
      }),
      "",
      "## iOS",
      "",
      needsMobile
        ? this.taskBlock({
            title: `Реализовать iOS-экран для ${featureArea}`,
            goal: "Собрать UI и состояния на mock data.",
            dependencies: "Описание макетов, тексты, дизайн-токены, API contract.",
            testing: "Snapshot/UI smoke, проверка accessibility labels.",
            merge: "Можно слить без QA, если экран скрыт feature flag и работает на mock data."
          })
        : "- iOS-задачи пока не требуются, если фича не затрагивает мобильное приложение.",
      "",
      needsMobile
        ? this.taskBlock({
            title: `Подключить iOS к API`,
            goal: "Добавить network layer, mapping DTO, обработку ошибок.",
            dependencies: "Backend endpoint и схема ошибок.",
            testing: "Unit-тесты mapping, ручной smoke на test environment.",
            merge: "Требуется QA перед включением feature flag."
          })
        : "",
      "",
      "## Android",
      "",
      needsMobile
        ? this.taskBlock({
            title: `Реализовать Android-экран для ${featureArea}`,
            goal: "Собрать UI и состояния на mock data.",
            dependencies: "Описание макетов, тексты, дизайн-токены, API contract.",
            testing: "Compose/UI preview или screenshot smoke.",
            merge: "Можно слить без QA, если экран скрыт feature flag и работает на mock data."
          })
        : "- Android-задачи пока не требуются, если фича не затрагивает мобильное приложение.",
      "",
      needsMobile
        ? this.taskBlock({
            title: `Подключить Android к API`,
            goal: "Добавить repository/use-case, DTO mapping, обработку ошибок.",
            dependencies: "Backend endpoint и схема ошибок.",
            testing: "Unit-тесты mapping, ручной smoke на test environment.",
            merge: "Требуется QA перед включением feature flag."
          })
        : "",
      "",
      "## QA И Аналитика",
      "",
      this.taskBlock({
        title: "Подготовить тестовую матрицу",
        goal: "Покрыть happy path, ошибки, пустые состояния, права доступа и регрессии.",
        dependencies: "Финальный список задач и API contract.",
        testing: "Сам документ тестируется ревью команды.",
        merge: "Можно слить без QA."
      }),
      "",
      this.taskBlock({
        title: "Описать аналитические события",
        goal: "Зафиксировать события, параметры, точки отправки и владельца дашборда.",
        dependencies: "Пользовательский сценарий и продуктовые метрики.",
        testing: "Проверка в debug/log режиме.",
        merge: "Можно слить без QA, если это только спецификация."
      }),
      "",
      "## Future Integrations",
      "",
      "- Project docs: подтянуть реальные архитектурные ограничения backend/web/iOS/Android.",
      "- Figma: подтянуть список экранов, компонентов, состояний и дизайн-токенов.",
      "- Jira: создавать Epic/Story/Task автоматически после подтверждения декомпозиции.",
      "- Team profile: учитывать уровень конкретных разработчиков и дробить задачи под их зоны ответственности."
    ].filter((line) => line !== "").join("\n");
  }

  taskBlock({ title, goal, dependencies, testing, merge }) {
    return [
      `### ${title}`,
      "",
      `- Цель: ${goal}`,
      `- Зависимости: ${dependencies}`,
      `- Критерии готовности: реализация соответствует контракту, покрыты основные состояния, нет скрытых блокировок для других ролей.`,
      `- Как тестировать: ${testing}`,
      `- Слияние: ${merge}`
    ].join("\n");
  }

  deriveTitle(task) {
    return this.firstLine(task)
      .replace(/^(нужно|надо|сделать|реализовать)\s+/i, "")
      .replace(/[.。]+$/g, "")
      .slice(0, 140);
  }

  detectArea(task) {
    if (/плат[её]ж|оплат|карта|тариф|billing/i.test(task)) {
      return "billing-сценария";
    }
    if (/день рожден|купон|промокод|товар|корзин|интернет-магазин|рекомендац/i.test(task)) {
      return "birthday-commerce сценария";
    }
    if (/профил|настройк|аккаунт/i.test(task)) {
      return "профиля пользователя";
    }
    if (/чат|сообщен|коммент/i.test(task)) {
      return "коммуникационного сценария";
    }
    if (/релиз|release|changelog|release notes|github/i.test(task)) {
      return "релизного сценария";
    }
    if (/поиск|фильтр|каталог|список/i.test(task)) {
      return "поискового сценария";
    }
    return "нового пользовательского сценария";
  }

  firstLine(value) {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => !line.startsWith("#")) || "пользовательский сценарий";
  }
}

async function saveResult(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content.trim()}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  const rawTask = args.inputPath
    ? await readFile(args.inputPath, "utf8")
    : await readMultilineInput();
  const decomposer = new EpicDecomposer({ mock: args.mock });
  const result = await decomposer.decompose(rawTask);

  await saveResult(args.outputPath, result);
  console.log(result);
  console.log("");
  console.log(`Декомпозиция сохранена: ${args.outputPath}`);
}

main().catch((error) => {
  console.error(`Ошибка декомпозиции: ${error.message}`);
  process.exitCode = 1;
});
