import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { SwarmCoordinator } from "./swarm-agent.js";

const useMock = process.argv.includes("--mock");

if (!useMock && !process.env.GIGACHAT_AUTH_KEY) {
  console.error("Задайте GIGACHAT_AUTH_KEY или используйте --mock.");
  process.exit(1);
}

const coordinator = new SwarmCoordinator({
  authKey: process.env.GIGACHAT_AUTH_KEY,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  mock: useMock
});

const cli = createInterface({ input, output });

if (!useMock) {
  console.log("Swarm Chat будет отправлять запросы к GigaChat после ваших сообщений.");
  console.log("Автоматического сценария нет: каждый вызов начинается только после вашего ввода.");
  const confirmation = await cli.question('Введите "ДА", чтобы продолжить: ');
  if (confirmation.trim() !== "ДА") {
    cli.close();
    console.log("Запуск отменен. Ни одного запроса к GigaChat не отправлено.");
    process.exit(0);
  }
}

function printRoute(report) {
  const lastUserIndex = report.messages.findLastIndex((message) => message.from === "User");
  const recentMessages =
    lastUserIndex >= 0 ? report.messages.slice(lastUserIndex) : report.messages.slice(-8);
  console.log("\nПайплайн агентов:");
  for (const message of recentMessages) {
    console.log(`- ${message.from} -> ${message.to}`);
  }
}

function printState(report) {
  console.log(`\nСостояние: ${report.state.phase}`);
  console.log(`Текущий шаг: ${report.state.currentStep}`);
}

function printResult(report) {
  console.log(`\nАгенты: ${report.agents.map((agent) => agent.name).join(", ")}`);
  printRoute(report);

  if (report.result.critic) {
    console.log(`\nCriticAgent: ${report.result.critic}`);
  }
  if (report.result.plan) {
    console.log(`\nPlannerAgent:\n${report.result.plan}`);
  }
  if (report.result.criticForPlan) {
    console.log(`\nCriticAgent по плану: ${report.result.criticForPlan}`);
  }
  if (report.result.execution) {
    console.log(`\nExecutorAgent:\n${report.result.execution}`);
  }
  if (report.result.criticForExecution) {
    console.log(`\nCriticAgent по реализации: ${report.result.criticForExecution}`);
  }
  if (report.result.validation) {
    console.log(`\nValidatorAgent: ${report.result.validation}`);
  }
  if (report.result.criticForValidation) {
    console.log(`\nCriticAgent по validation: ${report.result.criticForValidation}`);
  }
  if (report.result.memory) {
    console.log(`\nMemoryAgent: ${report.result.memory}`);
  }

  printState(report);
}

function printHelp() {
  console.log("Команды:");
  console.log("/run TASK — одним запросом запустить полный цикл planning -> execution -> validation -> done");
  console.log("/start TASK — создать задачу и зафиксировать инварианты REST API, PostgreSQL, запрет GraphQL");
  console.log("/state — показать состояние задачи");
  console.log("/invariants — показать инварианты");
  console.log("/log — показать весь журнал сообщений агентов");
  console.log("/validate — запустить ValidatorAgent");
  console.log("/exit — выйти");
  console.log("Любой другой текст считается вашим предложением и проходит через CriticAgent.");
}

console.log(`Swarm Chat запущен${useMock ? " в mock-режиме" : " через GigaChat API"}.`);
printHelp();
output.write("\nВы: ");

for await (const line of cli) {
  const text = line.trim();

  try {
    if (text === "/exit") {
      break;
    } else if (text === "/help") {
      printHelp();
    } else if (text === "/state") {
      console.log(JSON.stringify(coordinator.taskMachine.snapshotState(), null, 2));
    } else if (text === "/invariants") {
      console.log(JSON.stringify(coordinator.taskMachine.listInvariants(), null, 2));
    } else if (text === "/log") {
      console.log(JSON.stringify(coordinator.messages, null, 2));
    } else if (text.startsWith("/run ")) {
      const task = text.slice("/run ".length).trim();
      const report = await coordinator.run(task);
      printResult(report);
    } else if (text.startsWith("/start ")) {
      const task = text.slice("/start ".length).trim();
      const report = await coordinator.initializeInteractive(task);
      console.log("Задача создана.");
      printState(report);
      console.log("\nИнварианты:");
      for (const invariant of report.state.invariants) {
        console.log(`- ${invariant.description}`);
      }
    } else if (text === "/validate") {
      const report = await coordinator.validateCurrentResult();
      printResult(report);
    } else if (text) {
      const report = await coordinator.proposeChange(text);
      printResult(report);
    }
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
  }

  output.write("\nВы: ");
}

cli.close();
console.log("Swarm Chat завершен.");
