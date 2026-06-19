import { SwarmCoordinator } from "./swarm-agent.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const useRealApi = process.argv.includes("--real");
const skipConfirmation = process.argv.includes("--yes");

if (useRealApi && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Для --real задайте GIGACHAT_AUTH_KEY.");
  process.exit(1);
}

if (useRealApi && !skipConfirmation) {
  console.log("Будет выполнено несколько реальных запросов к GigaChat от разных role-agents.");
  console.log("Это автоматическая демонстрация роя, а не интерактивный чат.");
  console.log("Запросы расходуют API-квоту. Остановить выполнение можно через Ctrl+C.");

  const cli = createInterface({ input, output });
  const confirmation = await cli.question('Введите "ДА", чтобы продолжить: ');
  cli.close();

  if (confirmation.trim() !== "ДА") {
    console.log("Демонстрация отменена. Ни одного запроса к GigaChat не отправлено.");
    process.exit(0);
  }
}

const coordinator = new SwarmCoordinator({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  mock: !useRealApi
});

function printLine(label, value) {
  console.log(`${label}: ${String(value).replace(/\s+/g, " ").trim()}`);
}

function printReport(report) {
  console.log(`Агенты: ${report.agents.map((agent) => agent.name).join(", ")}`);
  console.log(`Маршрут сообщений:`);
  for (const message of report.messages) {
    console.log(`- ${message.from} -> ${message.to}`);
  }
  printLine("Финальное состояние", report.state.phase);
  printLine("Текущий шаг", report.state.currentStep);
  printLine(
    "Инварианты",
    report.state.invariants.map((invariant) => invariant.description).join("; ")
  );

  if (report.result.plan) {
    printLine("PlannerAgent", report.result.plan);
  }
  if (report.result.criticForPlan) {
    printLine("CriticAgent по плану", report.result.criticForPlan);
  }
  if (report.result.execution) {
    printLine("ExecutorAgent", report.result.execution);
  }
  if (report.result.validation) {
    printLine("ValidatorAgent", report.result.validation);
  }
  if (report.result.criticForExecution) {
    printLine("CriticAgent по реализации", report.result.criticForExecution);
  }
  if (report.result.memory) {
    printLine("MemoryAgent", report.result.memory);
  }
  if (report.result.badProposal) {
    printLine("Конфликтный запрос", report.result.badProposal);
  }
  if (report.result.critic) {
    printLine("CriticAgent", report.result.critic);
  }
}

console.log("=== Рой агентов: нормальный сценарий ===");
const report = await coordinator.run("Сделать API для управления задачами");
printReport(report);

console.log("\n=== Рой агентов: конфликт с инвариантом ===");
const conflictCoordinator = new SwarmCoordinator({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  mock: !useRealApi
});
const conflictReport = await conflictCoordinator.runConflict("Проверить запрет GraphQL");
printReport(conflictReport);
