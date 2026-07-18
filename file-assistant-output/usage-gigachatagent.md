# File Assistant Usage Report

Цель: найди использования GigaChatAgent
Запрос: GigaChatAgent
Найдено совпадений: 28

## Файлы
- README.md
- agent.js
- compression-demo.js
- context-strategy-agent.js
- developer-assistant.js
- file-assistant.js
- index.js
- layered-memory-agent.js
- local-rag-agent.js
- pr-review-agent.js
- rag-agent.js
- support-assistant.js
- swarm-agent.js
- token-demo.js

## Совпадения
- README.md:22 — Содержит отдельную сущность `GigaChatAgent`.
- README.md:421 — npm run file-assistant -- --goal "найди использования GigaChatAgent"
- README.md:424 — Результат сохраняется в `file-assistant-output/usage-gigachatagent.md`.
- agent.js:4 — export class GigaChatAgent {
- compression-demo.js:1 — import { GigaChatAgent } from "./agent.js";
- compression-demo.js:25 — return new GigaChatAgent({
- context-strategy-agent.js:1 — import { GigaChatAgent } from "./agent.js";
- context-strategy-agent.js:5 — export class ContextStrategyAgent extends GigaChatAgent {
- developer-assistant.js:7 — import { GigaChatAgent } from "./agent.js";
- developer-assistant.js:230 — this.llm = new GigaChatAgent({
- file-assistant.js:445 — return "GigaChatAgent";
- file-assistant.js:492 — console.log("Введите цель, например: найди использования GigaChatAgent");
- index.js:3 — import { GigaChatAgent } from "./agent.js";
- index.js:7 — const agent = new GigaChatAgent({
- layered-memory-agent.js:3 — import { GigaChatAgent } from "./agent.js";
- layered-memory-agent.js:7 — export class LayeredMemoryAgent extends GigaChatAgent {
- local-rag-agent.js:3 — import { GigaChatAgent } from "./agent.js";
- local-rag-agent.js:33 — this.cloud = new GigaChatAgent({
- pr-review-agent.js:5 — import { GigaChatAgent } from "./agent.js";
- pr-review-agent.js:260 — this.llm = new GigaChatAgent({
- rag-agent.js:3 — import { GigaChatAgent } from "./agent.js";
- rag-agent.js:123 — this.llm = new GigaChatAgent({
- support-assistant.js:7 — import { GigaChatAgent } from "./agent.js";
- support-assistant.js:245 — this.llm = new GigaChatAgent({
- swarm-agent.js:1 — import { GigaChatAgent } from "./agent.js";
- swarm-agent.js:27 — class RoleAgent extends GigaChatAgent {
- token-demo.js:1 — import { GigaChatAgent } from "./agent.js";
- token-demo.js:15 — const agent = new GigaChatAgent({

## Сводка MCP
# Usage report for GigaChatAgent

Запрос: GigaChatAgent
Найдено совпадений: 28
Файлов: 14

- README.md: 3 совпадений
  - строка 22: Содержит отдельную сущность `GigaChatAgent`.
  - строка 421: npm run file-assistant -- --goal "найди использования GigaChatAgent"
- agent.js: 1 совпадений
  - строка 4: export class GigaChatAgent {
- compression-demo.js: 2 совпадений
  - строка 1: import { GigaChatAgent } from "./agent.js";
  - строка 25: return new GigaChatAgent({
- context-strategy-agent.js: 2 совпадений
  - строка 1: import { GigaChatAgent } from "./agent.js";
  - строка 5: export class ContextStrategyAgent extends GigaChatAgent {
- developer-assistant.js: 2 совпадений
  - строка 7: import { GigaChatAgent } from "./agent.js";
  - строка 230: this.llm = new GigaChatAgent({
- file-assistant.js: 2 совпадений
  - строка 445: return "GigaChatAgent";
  - строка 492: console.log("Введите цель, например: найди использования GigaChatAgent");
- index.js: 2 совпадений
  - строка 3: import { GigaChatAgent } from "./agent.js";
  - строка 7: const agent = new GigaChatAgent({
- layered-memory-agent.js: 2 совпадений
  - строка 3: import { GigaChatAgent } from "./agent.js";
  - строка 7: export class LayeredMemoryAgent extends GigaChatAgent {
- local-rag-agent.js: 2 совпадений
  - строка 3: import { GigaChatAgent } from "./agent.js";
  - строка 33: this.cloud = new GigaChatAgent({
- pr-review-agent.js: 2 совпадений
  - строка 5: import { GigaChatAgent } from "./agent.js";
  - строка 260: this.llm = new GigaChatAgent({
- rag-agent.js: 2 совпадений
  - строка 3: import { GigaChatAgent } from "./agent.js";
  - строка 123: this.llm = new GigaChatAgent({
- support-assistant.js: 2 совпадений
  - строка 7: import { GigaChatAgent } from "./agent.js";
  - строка 245: this.llm = new GigaChatAgent({
- Еще файлов: 2

## Прочитанные файлы
- README.md: 53306 символов
- agent.js: 16480 символов
- compression-demo.js: 5812 символов
- context-strategy-agent.js: 7826 символов
- developer-assistant.js: 11581 символов
- file-assistant.js: 15340 символов

## Trace
1. search_project_files: совпадений: 28
2. read_project_file: README.md, символов: 53306 (обрезано)
3. read_project_file: agent.js, символов: 16480 (обрезано)
4. read_project_file: compression-demo.js, символов: 5812
5. read_project_file: context-strategy-agent.js, символов: 7826
6. read_project_file: developer-assistant.js, символов: 11581 (обрезано)
7. read_project_file: file-assistant.js, символов: 15340 (обрезано)
8. summarize_text: строк источника: 28
