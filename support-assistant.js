import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createInterface } from "node:readline/promises";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { GigaChatAgent } from "./agent.js";

const SUPPORT_DOCS_DIR = "support";
const MAX_CONTEXT_CHUNKS = Number(process.env.SUPPORT_TOP_K || 4);
const SIMILARITY_THRESHOLD = Number(process.env.SUPPORT_BACKLOG_THRESHOLD || 0.28);

const STOP_WORDS = new Set([
  "что",
  "как",
  "для",
  "или",
  "это",
  "если",
  "при",
  "над",
  "под",
  "почему",
  "можно",
  "нужно",
  "хочу",
  "the",
  "and",
  "with",
  "from",
  "this",
  "that"
]);

function parseArgs(argv) {
  return {
    mock: argv.includes("--mock")
  };
}

class SupportKnowledgeBase {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.chunks = [];
  }

  async build() {
    const files = await this.resolveDocs();
    const chunks = [];

    for (const file of files) {
      const content = await readFile(join(this.cwd, file), "utf8");
      chunks.push(...this.chunkFile(file, content));
    }

    this.chunks = chunks.map((chunk, index) => ({
      ...chunk,
      chunkId: `support-${String(index + 1).padStart(4, "0")}`,
      tokens: this.tokenize(chunk.text)
    }));
    return this.chunks;
  }

  async resolveDocs() {
    const entries = await readdir(join(this.cwd, SUPPORT_DOCS_DIR), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
      .map((entry) => `${SUPPORT_DOCS_DIR}/${entry.name}`);
  }

  chunkFile(source, content) {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const chunks = [];
    let section = "file";
    let buffer = [];
    let startLine = 1;

    const flush = (endLine) => {
      const text = buffer.join("\n").trim();
      if (!text) {
        return;
      }
      chunks.push({ source, section, lineStart: startLine, lineEnd: endLine, text });
    };

    for (const [index, line] of lines.entries()) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading && buffer.length > 0) {
        flush(index);
        buffer = [];
        startLine = index + 1;
      }
      if (heading) {
        section = heading[2].trim();
      }
      buffer.push(line);
    }

    flush(lines.length);
    return chunks;
  }

  search(message, topK = MAX_CONTEXT_CHUNKS) {
    const queryTokens = new Set(this.expandQueryTokens(message));

    return this.chunks
      .map((chunk) => {
        const uniqueTokens = [...new Set(chunk.tokens)];
        const overlap = uniqueTokens.filter((token) => queryTokens.has(token)).length;
        const authBoost = /авторизац|логин|sso|парол|вход/i.test(message) && /Авторизация|SSO|парол/i.test(chunk.text)
          ? 0.35
          : 0;
        const billingBoost = /оплат|billing|invoice|тариф/i.test(message) && /Оплата|invoice|тариф/i.test(chunk.text)
          ? 0.3
          : 0;
        const notificationBoost = /уведом|письм|email|почт|подтвержд/i.test(message) && /Уведомления|email|почт/i.test(chunk.text)
          ? 0.3
          : 0;
        const exportBoost = /экспорт|export|выгруз/i.test(message) && /Экспорт|export/i.test(chunk.text)
          ? 0.45
          : 0;
        const score = (queryTokens.size === 0 ? 0 : overlap / queryTokens.size) +
          authBoost +
          billingBoost +
          notificationBoost +
          exportBoost;
        return { ...chunk, score };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  expandQueryTokens(text) {
    const normalized = text.toLowerCase();
    const extra = [];
    const add = (...tokens) => extra.push(...tokens);

    if (/авторизац|логин|парол|sso|вход/.test(normalized)) {
      add("авторизация", "SSO", "workspace", "identity", "provider", "домен", "пароль");
    }
    if (/уведом|письм|email|почт|подтвержд/.test(normalized)) {
      add("уведомления", "email", "spam", "delivery", "подтверждение");
    }
    if (/экспорт|export|выгруз|завис/.test(normalized)) {
      add("экспорт", "export_job", "лимит", "роль", "project manager");
    }
    if (/оплат|тариф|лимит|invoice/.test(normalized)) {
      add("оплата", "invoice", "billing", "тариф", "лимит");
    }

    return [...new Set([...this.tokenize(text), ...extra.flatMap((item) => this.tokenize(item))])];
  }

  tokenize(text) {
    return String(text)
      .toLowerCase()
      .match(/[a-zа-яё0-9_/-]{3,}/gi)
      ?.map((token) => token.toLowerCase())
      .filter((token) => !STOP_WORDS.has(token)) || [];
  }

  format(chunks) {
    return chunks
      .map((chunk, index) =>
        [
          `[Источник ${index + 1}: ${chunk.source}; section=${chunk.section}; lines=${chunk.lineStart}-${chunk.lineEnd}; chunk_id=${chunk.chunkId}; score=${chunk.score.toFixed(2)}]`,
          chunk.text
        ].join("\n")
      )
      .join("\n\n");
  }
}

class SupportMcpBacklog {
  constructor({ cwd = "." } = {}) {
    this.cwd = cwd;
    this.transport = new StdioClientTransport({
      command: "node",
      args: ["mcp-support-server.js"],
      env: {
        SUPPORT_CRM_PATH: process.env.SUPPORT_CRM_PATH || "support/crm-data.json",
        SUPPORT_BACKLOG_PATH: process.env.SUPPORT_BACKLOG_PATH || "support/backlog.json"
      },
      stderr: "pipe"
    });
    this.client = new Client({
      name: "taskflow-support-service",
      version: "2.0.0"
    });
  }

  async connect() {
    await this.client.connect(this.transport);
  }

  async close() {
    await this.transport.close();
  }

  async callJson(name, args = {}) {
    const result = await this.client.callTool({
      name,
      arguments: {
        cwd: this.cwd,
        ...args
      }
    });
    const text = result.content.find((item) => item.type === "text")?.text || "{}";
    return JSON.parse(text);
  }

  async getCustomerContext() {
    return this.callJson("get_customer_context");
  }

  async listBacklog() {
    return this.callJson("list_backlog_items");
  }

  async findSimilarBacklogItems(query) {
    return this.callJson("find_similar_backlog_items", {
      query,
      threshold: SIMILARITY_THRESHOLD
    });
  }

  async createBacklogItem(item) {
    return this.callJson("create_backlog_item", item);
  }
}

class SupportAssistant {
  constructor({
    cwd = ".",
    mock = false,
    authKey = process.env.GIGACHAT_AUTH_KEY,
    model = process.env.GIGACHAT_MODEL || "GigaChat-2",
    scope = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
  } = {}) {
    this.cwd = cwd;
    this.mock = mock;
    this.kb = new SupportKnowledgeBase({ cwd });
    this.mcp = new SupportMcpBacklog({ cwd });
    this.llm = new GigaChatAgent({
      authKey,
      model,
      scope,
      compressionEnabled: false,
      historyPath: `/tmp/support-service-${crypto.randomUUID()}.json`,
      systemPrompt: "Ты сотрудник технической поддержки продукта TaskFlow."
    });
  }

  async init() {
    await this.kb.build();
    await this.mcp.connect();
  }

  async close() {
    await this.mcp.close();
  }

  async handleUserMessage(message) {
    const customer = await this.mcp.getCustomerContext();
    const chunks = this.kb.search(message);
    const scope = this.detectProductScope(message, chunks);
    const taskIntent = this.detectTaskIntent(message);
    let backlogAction = { type: "none", matches: [], created: null };

    if (!scope.inScope) {
      backlogAction = { type: "out_of_scope", matches: [], created: null };
    } else if (taskIntent.taskable) {
      const similar = await this.mcp.findSimilarBacklogItems(message);
      if (similar.matches?.length) {
        backlogAction = {
          type: "existing",
          matches: similar.matches
        };
      } else {
        const created = await this.mcp.createBacklogItem({
          ...this.buildBacklogItem(message, taskIntent),
          source: "support-chat"
        });
        backlogAction = {
          type: "created",
          created: created.item
        };
      }
    }

    if (this.mock || !process.env.GIGACHAT_AUTH_KEY) {
      return this.mockAnswer({ message, customer: customer.user, chunks, scope, taskIntent, backlogAction });
    }

    const prompt = this.buildPrompt({ message, customer: customer.user, chunks, scope, taskIntent, backlogAction });

    try {
      const completion = await this.llm.requestCompletion(
        [
          {
            role: "system",
            content: [
              "Ты сотрудник технической поддержки продукта TaskFlow.",
              "Отвечай пользователю вежливо, спокойно и понятно.",
              "Используй документацию продукта и контекст пользователя.",
              "Если обращение уже есть в backlog, скажи, что команда уже работает над этим направлением.",
              "Если новая задача создана, скажи, что обращение передано команде продукта.",
              "Если запрос не относится к код-ассистенту, вежливо объясни, что продукт этим не занимается, и не предлагай завести задачу.",
              "Не сообщай пользователю id задачи, внутренние поля backlog, score, source, chunk_id или технические детали MCP/RAG."
            ].join(" ")
          },
          { role: "user", content: prompt }
        ],
        800
      );
      return this.sanitizeUserAnswer(completion.answer);
    } catch (error) {
      return [
        "Сейчас не получилось обратиться к AI-модели, но я все равно помогу по данным сервиса.",
        "",
        this.mockAnswer({ message, customer: customer.user, chunks, scope, taskIntent, backlogAction })
      ].join("\n");
    }
  }

  detectProductScope(message, chunks) {
    const normalized = message.toLowerCase();
    const productKeywords = /код|ассистент|проект|readme|документац|github|git|ветк|pr|pull request|ревью|review|diff|mcp|rag|llm|api|авторизац|логин|sso|парол|вход|экспорт|export|уведом|email|почт|оплат|тариф|workspace|backlog|задач|интерфейс|темн|theme/i;
    const externalGoods = /воздушн\w*\s+шар|шарик|пицц|еда|ресторан|одежд|обув|билет|доставк|такси|отел|гостиниц|товар|магазин|купить|прода(е|ё|ю|й)/i;
    const productDocHit = chunks.some((chunk) => chunk.score >= 0.25);

    if (externalGoods.test(normalized)) {
      return {
        inScope: false,
        reason: "Запрос относится к внешним товарам или услугам, а не к код-ассистенту."
      };
    }

    if (productKeywords.test(normalized) || productDocHit) {
      return {
        inScope: true,
        reason: "Запрос относится к функциям код-ассистента."
      };
    }

    return {
      inScope: false,
      reason: "В запросе не найдено связи с продуктом TaskFlow Code Assistant."
    };
  }

  detectTaskIntent(message) {
    const normalized = message.toLowerCase();
    const feature = /добав(ьте|ить)|сдела(йте|ть)|хочу|нужн[аоы]? возможность|не хватает|было бы удобно|поддерж(ите|ку)|интеграц/i.test(normalized);
    const bug = /не работает|сломал|сломалось|ошибка|баг|завис|падает|не приходит|не открывается|не сохраняется|пропал/i.test(normalized);
    const howTo = /^(как|где|можно ли|что такое|сколько|какой|какие)\b/i.test(normalized);
    const answerableKnownIssue = howTo && !bug && !feature;

    if (answerableKnownIssue) {
      return { taskable: false, type: "question", area: this.detectArea(message) };
    }

    if (feature) {
      return { taskable: true, type: "feature", area: this.detectArea(message) };
    }

    if (bug) {
      return { taskable: true, type: "bug", area: this.detectArea(message) };
    }

    return { taskable: false, type: "question", area: this.detectArea(message) };
  }

  detectArea(message) {
    if (/авторизац|логин|парол|sso|вход/i.test(message)) {
      return "auth";
    }
    if (/уведом|письм|email|почт|подтвержд/i.test(message)) {
      return "notifications";
    }
    if (/экспорт|export|выгруз/i.test(message)) {
      return "export";
    }
    if (/оплат|тариф|invoice|billing/i.test(message)) {
      return "billing";
    }
    if (/темн|интерфейс|дизайн|theme|ui/i.test(message)) {
      return "interface";
    }
    return "general";
  }

  buildBacklogItem(message, taskIntent) {
    const titleByArea = {
      auth: taskIntent.type === "bug" ? "Проверить проблему авторизации пользователя" : "Улучшить сценарий авторизации",
      notifications: taskIntent.type === "bug" ? "Проверить доставку уведомлений пользователю" : "Улучшить управление уведомлениями",
      export: taskIntent.type === "bug" ? "Проверить проблему экспорта данных" : "Улучшить экспорт данных",
      billing: taskIntent.type === "bug" ? "Проверить проблему оплаты" : "Улучшить платежный сценарий",
      interface: "Улучшить интерфейс продукта",
      general: "Обработать обращение пользователя"
    };

    return {
      title: titleByArea[taskIntent.area] || titleByArea.general,
      description: message,
      type: taskIntent.type === "bug" ? "bug" : "feature",
      area: taskIntent.area
    };
  }

  buildPrompt({ message, customer, chunks, scope, taskIntent, backlogAction }) {
    return [
      "Сообщение пользователя:",
      message,
      "",
      "Контекст пользователя:",
      customer ? JSON.stringify(customer, null, 2) : "Пользователь не найден.",
      "",
      "Релевантная документация продукта:",
      this.kb.format(chunks) || "Релевантная документация не найдена.",
      "",
      "Проверка границ продукта:",
      JSON.stringify(scope, null, 2),
      "",
      "Решение сервиса по backlog:",
      JSON.stringify(this.publicBacklogAction(scope, taskIntent, backlogAction), null, 2),
      "",
      "Сформируй только ответ пользователю от лица сотрудника техподдержки."
    ].join("\n");
  }

  publicBacklogAction(scope, taskIntent, backlogAction) {
    return {
      inProductScope: scope.inScope,
      taskable: taskIntent.taskable,
      requestType: taskIntent.type,
      area: taskIntent.area,
      action: backlogAction.type,
      existingStatus: backlogAction.matches?.[0]?.status || null
    };
  }

  mockAnswer({ message, customer, chunks, scope, taskIntent, backlogAction }) {
    const lines = [];
    const name = customer?.name?.split(" ")[0];
    const greeting = name ? `${name}, ` : "";
    const relevant = chunks[0];

    if (!scope.inScope) {
      lines.push(`${greeting}спасибо за вопрос. Мы не занимаемся такими товарами или услугами.`);
      lines.push("TaskFlow Code Assistant — это код-ассистент для работы с проектами, документацией, Git-контекстом, RAG и ревью кода.");
      lines.push("Поэтому я не буду передавать это обращение в команду продукта, чтобы backlog оставался только для задач по нашему сервису.");
      return lines.join("\n");
    } else if (backlogAction.type === "existing") {
      lines.push(`${greeting}спасибо, что написали. Мы уже знаем об этом сценарии, и команда продукта уже работает над улучшением.`);
      lines.push("Пока работа идет, я рекомендую воспользоваться текущими обходными шагами из справки ниже.");
    } else if (backlogAction.type === "created") {
      lines.push(`${greeting}спасибо за подробное описание. Я передал обращение команде продукта, чтобы его разобрали и добавили в план работ.`);
      lines.push("Мы не можем обещать точный срок прямо сейчас, но такие обращения помогают правильно расставлять приоритеты.");
    } else if (relevant) {
      lines.push(`${greeting}по этому вопросу могу подсказать следующее.`);
    } else {
      lines.push(`${greeting}спасибо за обращение. Мне нужно чуть больше деталей, чтобы подсказать точнее.`);
    }

    const shouldAddTroubleshooting = backlogAction.type !== "created" || taskIntent.type === "bug";

    if (shouldAddTroubleshooting && taskIntent.area === "auth") {
      lines.push("Если в рабочем пространстве включен SSO, вход по паролю может быть недоступен. Попробуйте войти через корпоративную кнопку SSO.");
    } else if (shouldAddTroubleshooting && taskIntent.area === "notifications") {
      lines.push("Проверьте папку spam и настройки email-уведомлений в профиле. Если письмо не появится, запросите повторную отправку.");
    } else if (shouldAddTroubleshooting && taskIntent.area === "export") {
      lines.push("Для больших проектов экспорт может занимать до 15 минут. Если ожидание дольше, стоит повторить экспорт позже или обратиться к администратору workspace.");
    } else if (shouldAddTroubleshooting && taskIntent.area === "billing") {
      lines.push("По оплате стоит проверить статус последнего счета, лимиты банка и актуальность платежного профиля.");
    } else if (!taskIntent.taskable) {
      lines.push("Если опишете, какой раздел продукта вы используете и что именно видите на экране, я смогу помочь быстрее.");
    }

    if (/темн|dark|theme/i.test(message)) {
      lines.push("Запрос по темной теме уже находится в работе у команды продукта.");
    }

    return lines.join("\n");
  }

  sanitizeUserAnswer(answer) {
    return answer
      .replace(/\b(?:SUP|TASK|BACKLOG)-?\d+\b/gi, "обращение")
      .replace(/\bchunk_id\s*[:=]\s*\S+/gi, "")
      .replace(/\bscore\s*[:=]\s*\S+/gi, "")
      .trim();
  }

  async formatBacklogForDemo() {
    const result = await this.mcp.listBacklog();
    const items = result.items || [];

    if (!items.length) {
      return "Backlog пуст.";
    }

    return items
      .map((item) => `#${item.id} [${item.status}] ${item.type}/${item.area}: ${item.title}`)
      .join("\n");
  }
}

const args = parseArgs(process.argv);
const assistant = new SupportAssistant({ cwd: ".", mock: args.mock });
await assistant.init();

const cli = createInterface({ input, output });
console.log(`Support Service запущен${args.mock ? " в mock-режиме" : ""}.`);
console.log("Пользователь пишет обычный вопрос или проблему. Служебные команды для демонстрации: /backlog, /exit");
output.write("\nПользователь: ");

for await (const line of cli) {
  const text = line.trim();

  if (!text) {
    output.write("\nПользователь: ");
    continue;
  }

  if (text === "/exit") {
    break;
  }

  if (text === "/backlog") {
    console.log(await assistant.formatBacklogForDemo());
    output.write("\nПользователь: ");
    continue;
  }

  console.log("\nПоддержка:");
  console.log(await assistant.handleUserMessage(text));
  output.write("\nПользователь: ");
}

cli.close();
await assistant.close();
console.log("Support Service завершен.");
