# Архитектура проекта

Проект состоит из нескольких учебных подсистем, каждая демонстрирует отдельный аспект работы с LLM:

- `index.js` и `agent.js` — базовый CLI-чат с GigaChat, историей, токенами и компрессией контекста.
- `local-llm-cli.js` и `ollama-agent.js` — CLI-чат с локальной LLM через Ollama.
- `rag-agent.js`, `rag-demo.js`, `local-rag-agent.js`, `local-rag-demo.js` — RAG-режимы по документам проекта.
- `mcp-server.js`, `mcp-client.js`, `mcp-agent.js` — локальный MCP-сервер, MCP-клиент и агент, который вызывает MCP-инструменты.
- `mcp-pipeline-agent.js` и `mcp-orchestrator-agent.js` — композиция и оркестрация MCP-инструментов.
- `swarm-agent.js` и `swarm-cli.js` — рой агентов с жизненным циклом задачи и инвариантами.
- `private-ai-service.js` и `private-ai-public/` — приватный локальный AI-сервис с HTTP API и web-интерфейсом.
- `developer-assistant.js` — ассистент разработчика, который отвечает на вопросы о проекте через RAG и MCP.

Основная команда для ассистента разработчика:

```bash
npm run dev-assistant
```

Для проверки без локальной LLM:

```bash
npm run dev-assistant -- --mock
```

