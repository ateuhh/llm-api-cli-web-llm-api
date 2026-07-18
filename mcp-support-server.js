import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

const CRM_PATH = process.env.SUPPORT_CRM_PATH || "support/crm-data.json";
const BACKLOG_PATH = process.env.SUPPORT_BACKLOG_PATH || "support/backlog.json";

const server = new McpServer({
  name: "taskflow-support-mcp",
  version: "2.0.0"
});

async function readJson(path, fallback, cwd = ".") {
  try {
    const raw = await readFile(resolvePath(cwd, path), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, value, cwd = ".") {
  const fullPath = resolvePath(cwd, path);
  const temporaryPath = `${fullPath}.tmp`;
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, fullPath);
}

function resolvePath(cwd, path) {
  return isAbsolute(path) ? path : join(cwd, path);
}

async function loadCrm(cwd = ".") {
  const data = await readJson(CRM_PATH, { users: [] }, cwd);
  return {
    users: Array.isArray(data.users) ? data.users : []
  };
}

async function loadBacklog(cwd = ".") {
  const data = await readJson(BACKLOG_PATH, { nextId: 1, items: [] }, cwd);
  return {
    nextId: Number.isInteger(data.nextId) ? data.nextId : 1,
    items: Array.isArray(data.items) ? data.items : []
  };
}

function jsonResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .match(/[a-zа-яё0-9_/-]{3,}/gi)
    ?.map((token) => normalizeToken(token.toLowerCase()))
    .filter((token) => ![
      "что",
      "как",
      "для",
      "или",
      "это",
      "если",
      "при",
      "над",
      "под",
      "мен",
      "добавьт",
      "добав",
      "сдела",
      "улучш"
    ].includes(token)) || [];
}

function normalizeToken(token) {
  if (token.startsWith("завис")) {
    return "завис";
  }
  if (token.startsWith("экспорт")) {
    return "экспорт";
  }
  if (token.startsWith("проект")) {
    return "проект";
  }
  if (token.startsWith("подтвержд")) {
    return "подтвержд";
  }
  if (token.startsWith("отправ")) {
    return "отправ";
  }
  if (token.startsWith("авторизац")) {
    return "авторизац";
  }

  return token.replace(
    /(ами|ями|ого|его|ому|ему|ыми|ими|ых|их|ая|яя|ое|ее|ые|ие|ый|ий|ой|ам|ям|ах|ях|ов|ев|ия|ие|а|я|ы|и|е|у|ю|ом|ем)$/u,
    ""
  );
}

function similarity(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));

  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / a.size;
}

function itemText(item) {
  return [
    item.title,
    item.description,
    item.area,
    item.type,
    ...(item.keywords || [])
  ].filter(Boolean).join(" ");
}

server.registerTool(
  "get_customer_context",
  {
    description: "Возвращает демо-контекст текущего пользователя поддержки.",
    inputSchema: {
      cwd: z.string().default(".").describe("Папка проекта.")
    }
  },
  async ({ cwd }) => {
    const crm = await loadCrm(cwd);
    return jsonResult({
      ok: true,
      user: crm.users[0] || null
    });
  }
);

server.registerTool(
  "list_backlog_items",
  {
    description: "Возвращает список задач продуктового backlog.",
    inputSchema: {
      cwd: z.string().default(".").describe("Папка проекта.")
    }
  },
  async ({ cwd }) => {
    const backlog = await loadBacklog(cwd);
    return jsonResult({
      ok: true,
      total: backlog.items.length,
      items: backlog.items
    });
  }
);

server.registerTool(
  "find_similar_backlog_items",
  {
    description: "Ищет похожие задачи в backlog по смысловому описанию.",
    inputSchema: {
      query: z.string().min(1).describe("Описание проблемы или пожелания пользователя."),
      cwd: z.string().default(".").describe("Папка проекта."),
      threshold: z.number().min(0).max(1).default(0.3).describe("Минимальная похожесть.")
    }
  },
  async ({ query, cwd, threshold }) => {
    const backlog = await loadBacklog(cwd);
    const matches = backlog.items
      .map((item) => ({
        ...item,
        similarity: similarity(query, itemText(item))
      }))
      .filter((item) => item.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity);

    return jsonResult({
      ok: true,
      query,
      total: matches.length,
      matches
    });
  }
);

server.registerTool(
  "create_backlog_item",
  {
    description: "Создает новую задачу в backlog продукта.",
    inputSchema: {
      title: z.string().min(1).describe("Короткое название задачи."),
      description: z.string().min(1).describe("Описание пользовательской проблемы или пожелания."),
      type: z.enum(["bug", "feature", "improvement"]).describe("Тип задачи."),
      area: z.string().min(1).describe("Область продукта."),
      source: z.string().default("support-chat").describe("Источник задачи."),
      cwd: z.string().default(".").describe("Папка проекта.")
    }
  },
  async ({ title, description, type, area, source, cwd }) => {
    const backlog = await loadBacklog(cwd);
    const id = backlog.nextId;
    const item = {
      id,
      title,
      description,
      type,
      area,
      status: "triage",
      source,
      createdAt: new Date().toISOString(),
      keywords: tokenize(`${title} ${description} ${area}`).slice(0, 12)
    };

    backlog.nextId += 1;
    backlog.items.push(item);
    await writeJson(BACKLOG_PATH, backlog, cwd);

    return jsonResult({
      ok: true,
      item
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
