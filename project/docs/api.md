# API и команды проекта

## Приватный AI-сервис

Запуск:

```bash
ollama serve
npm run private-ai
```

По умолчанию сервис доступен только локально:

```text
http://127.0.0.1:8787
```

Endpoint'ы:

- `GET /api/health` — проверка состояния сервиса.
- `GET /api/stats` — счетчики и лимиты.
- `POST /api/chat` — чат с локальной LLM.

## MCP

MCP-сервер запускается через:

```bash
npm run mcp-server
```

Минимальный инструмент для ассистента разработчика:

- `git_status` — возвращает текущую git-ветку, чистоту рабочего дерева и список измененных файлов.

Дополнительные инструменты:

- `project_info`;
- `search_project_files`;
- `summarize_text`;
- `save_to_file`;
- `schedule_summary`;
- `list_summaries`;
- `stop_summary`.

## RAG

Документация для ассистента разработчика берется из:

- `README.md`;
- `project/docs/*.md`.

Ассистент ищет релевантные чанки документации и добавляет к ответу MCP-контекст, включая текущую git-ветку.
