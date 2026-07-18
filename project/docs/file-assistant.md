# File Assistant

## Назначение

File Assistant выполняет реальные операции с файлами проекта через MCP: ищет по нескольким файлам, читает найденные источники, анализирует содержимое и сохраняет результат в новый или существующий файл.

Последняя цель обновления: обнови документацию по файловому ассистенту

## Основные сценарии

- Найти все места, где используется компонент, класс, API или команда.
- Обновить документацию по текущему коду проекта.
- Сгенерировать ADR или snapshot проекта.
- Подготовить diff после сохранения результата.

## MCP-инструменты

- `list_project_files` — получает список текстовых файлов проекта.
- `read_project_file` — читает выбранный файл проекта.
- `search_project_files` — ищет строку или идентификатор по файлам.
- `summarize_text` — делает краткую сводку по найденным совпадениям.
- `save_to_file` — сохраняет отчет или документацию.

## Команды запуска

- `npm run file-assistant` — `node file-assistant.js`

## Прочитанный контекст

- package.json: 3310 символов
- README.md: 53306 символов
- mcp-files-server.js: 7288 символов
- file-assistant.js: 15340 символов
- project/docs/architecture.md: 1118 символов
- project/docs/api.md: 936 символов

## Структура проекта

- README.md
- agent.js
- chat-history.json
- compression-demo.js
- context-strategy-agent.js
- developer-assistant.js
- document-index-demo.js
- document-indexer.js
- file-assistant.js
- index.js
- layered-memory-agent.js
- local-llm-cli.js
- local-llm-optimization-demo.js
- local-rag-agent.js
- local-rag-demo.js
- mcp-agent.js
- mcp-client.js
- mcp-files-server.js
- mcp-git-server.js
- mcp-orchestrator-agent.js
- mcp-pipeline-agent.js
- mcp-scheduler-agent.js
- mcp-server.js
- mcp-support-server.js
- memory-cli.js
- memory-demo.js
- memory-layers.json
- ollama-agent.js
- package-lock.json
- package.json
- personalization-demo.js
- pr-review-agent.js
- private-ai-public/app.js
- private-ai-service.js
- project/docs/api.md
- project/docs/architecture.md
- project/docs/file-assistant.md
- rag-agent.js
- rag-chat-cli.js
- rag-chat-demo.js
- rag-demo.js
- rag-memory-chat.js
- strategy-cli.js
- strategy-demo.js
- support/backlog.json
- support/crm-data.json
- support/faq.md
- support/product-docs.md
- support-assistant.js
- swarm-agent.js
- swarm-cli.js
- swarm-demo.js
- task-state-cli.js
- task-state-demo.js
- task-state-machine-agent.js
- task-state.json
- token-demo.js

## Trace Последнего Обновления

1. list_project_files: файлов: 57, показано: 57
2. read_project_file: package.json, символов: 3310
3. read_project_file: README.md, символов: 53306 (обрезано)
4. read_project_file: mcp-files-server.js, символов: 7288
5. read_project_file: file-assistant.js, символов: 15340 (обрезано)
6. read_project_file: project/docs/architecture.md, символов: 1118
7. read_project_file: project/docs/api.md, символов: 936
