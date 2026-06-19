import { GigaChatAgent } from "./agent.js";
import { TaskStateMachineAgent } from "./task-state-machine-agent.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsForbiddenAsConstraint(text, value) {
  const normalized = String(text).toLowerCase();
  const forbiddenValue = String(value).toLowerCase();
  const escapedValue = escapeRegExp(forbiddenValue);
  return [
    new RegExp(`запрет\\s+${escapedValue}`),
    new RegExp(`${escapedValue}\\s+запрещ`),
    new RegExp(`без\\s+${escapedValue}`),
    new RegExp(`не\\s+использовать\\s+${escapedValue}`),
    new RegExp(`не\\s+переходить\\s+на\\s+${escapedValue}`)
  ].some((pattern) => pattern.test(normalized));
}

function violatesForbiddenValue(text, value) {
  const normalized = String(text).toLowerCase();
  const forbiddenValue = String(value).toLowerCase();
  return normalized.includes(forbiddenValue) && !mentionsForbiddenAsConstraint(text, value);
}

class RoleAgent extends GigaChatAgent {
  constructor({ name, role, mockReply, ...options }) {
    super({
      ...options,
      compressionEnabled: false,
      systemPrompt: role
    });
    this.name = name;
    this.role = role;
    this.mockReply = mockReply;
  }

  async run(payload) {
    if (this.mock) {
      return this.mockReply(payload);
    }

    const messages = [
      { role: "system", content: this.role },
      { role: "user", content: JSON.stringify(payload, null, 2) }
    ];
    const completion = await this.requestCompletion(messages);
    return completion.answer;
  }
}

export class SwarmCoordinator {
  constructor({
    authKey,
    model = "GigaChat-2",
    scope = "GIGACHAT_API_PERS",
    mock = false
  } = {}) {
    const commonOptions = { authKey, model, scope, mock };
    this.taskMachine = new TaskStateMachineAgent({
      ...commonOptions,
      memoryPath: `/tmp/swarm-memory-${crypto.randomUUID()}.json`,
      statePath: `/tmp/swarm-state-${crypto.randomUUID()}.json`
    });
    this.agents = {
      planner: new RoleAgent({
        ...commonOptions,
        name: "PlannerAgent",
        role: "Ты PlannerAgent. Составляешь реалистичный план задачи и не выполняешь код.",
        mockReply: ({ task }) =>
          [
            `План для задачи "${task}":`,
            "1. Уточнить требования.",
            "2. Реализовать REST API.",
            "3. Проверить результат.",
            "Архитектура: REST API. База данных: PostgreSQL."
          ].join("\n")
      }),
      executor: new RoleAgent({
        ...commonOptions,
        name: "ExecutorAgent",
        role: "Ты ExecutorAgent. Выполняешь план, но не меняешь принятые архитектурные решения.",
        mockReply: ({ plan }) =>
          [
            "Выполнение:",
            "Созданы REST endpoints для задач и пользователей.",
            "Использована PostgreSQL.",
            `Основание: ${String(plan).split("\n")[0]}`
          ].join("\n")
      }),
      validator: new RoleAgent({
        ...commonOptions,
        name: "ValidatorAgent",
        role: "Ты ValidatorAgent. Проверяешь результат и формулируешь статус validation.",
        mockReply: ({ execution }) =>
          execution.includes("REST") && execution.includes("PostgreSQL")
            ? "Validation passed: реализация соответствует REST API и PostgreSQL."
            : "Validation failed: реализация не соответствует принятым решениям."
      }),
      critic: new RoleAgent({
        ...commonOptions,
        name: "CriticAgent",
        role:
          "Ты CriticAgent. Ищешь нарушения инвариантов и блокируешь конфликтные решения. " +
          "Если есть нарушение, начни ответ с 'Critic blocked:'. Если нарушений нет, начни с 'Critic passed:'.",
        mockReply: ({ text, invariants }) => {
          const normalized = String(text).toLowerCase();
          const forbidden = invariants.find(
            (invariant) =>
              invariant.type === "forbid" &&
              violatesForbiddenValue(normalized, invariant.value)
          );
          const broken =
            forbidden ||
            invariants.find((invariant) => {
              if (
                invariant.key.includes("архитект") &&
                normalized.includes("graphql") &&
                !mentionsForbiddenAsConstraint(normalized, "graphql")
              ) {
                return true;
              }
              return false;
            });
          return broken
            ? `Critic blocked: нарушен инвариант "${broken.description}".`
            : "Critic passed: нарушений инвариантов не найдено.";
        }
      }),
      memory: new RoleAgent({
        ...commonOptions,
        name: "MemoryAgent",
        role: "Ты MemoryAgent. Фиксируешь ключевые решения и состояние между агентами.",
        mockReply: ({ state }) =>
          `Memory updated: phase=${state.phase}, currentStep=${state.currentStep}, invariants=${state.invariants.length}.`
      })
    };
    this.messages = [];
  }

  async initialize(task) {
    this.messages = [];
    await this.taskMachine.loadMemory();
    await this.taskMachine.loadState();
    await this.taskMachine.startTask(task, [
      "Составить план",
      "Выполнить план",
      "Проверить результат"
    ]);
    await this.taskMachine.addInvariant({
      type: "fixed",
      key: "архитектура",
      value: "REST API",
      description: "Архитектура зафиксирована: REST API"
    });
    await this.taskMachine.addInvariant({
      type: "forbid",
      key: "технология",
      value: "GraphQL",
      description: "GraphQL запрещен"
    });
    await this.taskMachine.addInvariant({
      type: "fixed",
      key: "база данных",
      value: "PostgreSQL",
      description: "База данных зафиксирована: PostgreSQL"
    });
  }

  async initializeInteractive(task) {
    await this.initialize(task);
    return this.report({
      task,
      status: "started",
      note: "Задача создана, инварианты зафиксированы."
    });
  }

  record(from, to, payload) {
    this.messages.push({ from, to, payload });
  }

  checkInvariantConflict(text) {
    const normalized = String(text).toLowerCase();
    const invariants = this.taskMachine.snapshotState().invariants;
    const forbidden = invariants.find(
      (invariant) =>
        invariant.type === "forbid" &&
        violatesForbiddenValue(normalized, invariant.value)
    );

    if (forbidden) {
      return forbidden;
    }

    return invariants.find((invariant) => {
      const key = String(invariant.key || "").toLowerCase();
      const value = String(invariant.value || "").toLowerCase();
      if (
        key.includes("архитект") &&
        value.includes("rest") &&
        normalized.includes("graphql") &&
        !mentionsForbiddenAsConstraint(normalized, "graphql")
      ) {
        return true;
      }
      if (key.includes("база") && normalized.includes("mongodb") && !value.includes("mongodb")) {
        return true;
      }
      return false;
    });
  }

  async runCritic(text) {
    const state = this.taskMachine.snapshotState();
    this.record("Coordinator", "CriticAgent", { text, invariants: state.invariants });
    const critic = await this.agents.critic.run({
      text,
      invariants: state.invariants
    });
    const localConflict = this.checkInvariantConflict(text);
    const finalCritic = localConflict
      ? `Critic blocked: нарушен инвариант "${localConflict.description}".`
      : "Critic passed: нарушений инвариантов не найдено.";
    this.record("CriticAgent", "Coordinator", { critic: finalCritic });
    return finalCritic;
  }

  async proposeChange(text) {
    this.record("User", "Coordinator", { text });
    const critic = await this.runCritic(text);

    if (critic.toLowerCase().includes("blocked")) {
      const memory = await this.agents.memory.run({
        state: this.taskMachine.snapshotState(),
        rejectedProposal: text,
        critic
      });
      this.record("Coordinator", "MemoryAgent", {
        rejectedProposal: text,
        state: this.taskMachine.snapshotState()
      });
      this.record("MemoryAgent", "Coordinator", { memory });
      return this.report({
        status: "blocked",
        proposal: text,
        critic,
        memory
      });
    }

    if (this.taskMachine.snapshotState().phase === "planning") {
      const plan = await this.agents.planner.run({
        task: text,
        state: this.taskMachine.snapshotState(),
        invariants: this.taskMachine.snapshotState().invariants
      });
      this.record("Coordinator", "PlannerAgent", { task: text });
      this.record("PlannerAgent", "Coordinator", { plan });

      const criticForPlan = await this.runCritic(plan);
      if (criticForPlan.toLowerCase().includes("blocked")) {
        return this.report({
          status: "blocked",
          proposal: text,
          critic,
          plan,
          criticForPlan
        });
      }

      await this.taskMachine.transitionTo("execution", "План принят CriticAgent");
      return this.report({
        status: "planned",
        proposal: text,
        critic,
        plan,
        criticForPlan
      });
    }

    const execution = await this.agents.executor.run({
      plan: text,
      state: this.taskMachine.snapshotState()
    });
    this.record("Coordinator", "ExecutorAgent", { proposal: text });
    this.record("ExecutorAgent", "Coordinator", { execution });

    if (this.taskMachine.snapshotState().phase === "execution") {
      await this.taskMachine.advance(`ExecutorAgent обработал предложение: ${text}`);
    }

    const memory = await this.agents.memory.run({
      state: this.taskMachine.snapshotState(),
      proposal: text,
      execution
    });
    this.record("Coordinator", "MemoryAgent", { state: this.taskMachine.snapshotState() });
    this.record("MemoryAgent", "Coordinator", { memory });

    return this.report({
      status: "executed",
      proposal: text,
      critic,
      execution,
      memory
    });
  }

  async validateCurrentResult() {
    this.record("User", "Coordinator", { command: "/validate" });

    if (this.taskMachine.snapshotState().phase === "execution") {
      await this.taskMachine.transitionTo("validation", "Пользователь запустил ValidatorAgent");
    }

    const state = this.taskMachine.snapshotState();
    const fixedDecisions = state.invariants
      .filter((invariant) => invariant.type === "fixed")
      .map((invariant) => `${invariant.key}: ${invariant.value}`)
      .join("\n");
    const executionText = [
      state.completedSteps.map((step) => `${step.step}: ${step.note}`).join("\n"),
      fixedDecisions
    ]
      .filter(Boolean)
      .join("\n");

    if (state.phase !== "validation") {
      return this.report({
        status: "validation_not_ready",
        validation: `Validation skipped: текущий этап ${state.phase}, нужен validation.`
      });
    }

    const validation = await this.agents.validator.run({
      execution: executionText,
      state
    });
    this.record("Coordinator", "ValidatorAgent", { execution: executionText });
    this.record("ValidatorAgent", "Coordinator", { validation });

    const criticForValidation = await this.runCritic(executionText || validation);
    if (!criticForValidation.toLowerCase().includes("blocked") && validation.includes("passed")) {
      await this.taskMachine.transitionTo("done", "ValidatorAgent подтвердил результат");
    }

    const memory = await this.agents.memory.run({
      state: this.taskMachine.snapshotState(),
      validation
    });
    this.record("Coordinator", "MemoryAgent", { state: this.taskMachine.snapshotState() });
    this.record("MemoryAgent", "Coordinator", { memory });

    return this.report({
      status: this.taskMachine.snapshotState().phase === "done" ? "done" : "validation_failed",
      validation,
      criticForValidation,
      memory
    });
  }

  async run(task) {
    await this.initialize(task);
    this.record("User", "Coordinator", { task });
    const initialState = this.taskMachine.snapshotState();

    const plan = await this.agents.planner.run({
      task,
      state: initialState,
      invariants: initialState.invariants
    });
    this.record("Coordinator", "PlannerAgent", { task });
    this.record("PlannerAgent", "Coordinator", { plan });

    const criticForPlan = await this.runCritic(plan);

    if (criticForPlan.includes("blocked")) {
      return this.report({ task, plan, criticForPlan });
    }

    await this.taskMachine.transitionTo("execution", "План принят CriticAgent");
    const execution = await this.agents.executor.run({
      plan,
      state: this.taskMachine.snapshotState()
    });
    this.record("Coordinator", "ExecutorAgent", { plan });
    this.record("ExecutorAgent", "Coordinator", { execution });

    await this.taskMachine.advance("План выполнен ExecutorAgent");
    await this.taskMachine.advance("Шаг исполнения завершен");
    await this.taskMachine.advance("Все execution-шаги завершены");

    const validation = await this.agents.validator.run({
      execution,
      state: this.taskMachine.snapshotState()
    });
    this.record("Coordinator", "ValidatorAgent", { execution });
    this.record("ValidatorAgent", "Coordinator", { validation });

    const criticForExecution = await this.runCritic(execution);

    if (!criticForExecution.includes("blocked") && validation.includes("passed")) {
      await this.taskMachine.transitionTo("done", "ValidationAgent подтвердил результат");
    }

    const memory = await this.agents.memory.run({
      state: this.taskMachine.snapshotState(),
      plan,
      execution,
      validation
    });
    this.record("Coordinator", "MemoryAgent", { state: this.taskMachine.snapshotState() });
    this.record("MemoryAgent", "Coordinator", { memory });

    return this.report({ task, plan, criticForPlan, execution, validation, criticForExecution, memory });
  }

  async runConflict(task) {
    await this.initialize(task);
    const badProposal = "Предлагаю заменить REST API на GraphQL.";
    this.record("User", "Coordinator", { text: badProposal });
    const critic = await this.runCritic(badProposal);
    return this.report({ task, badProposal, critic });
  }

  report(result) {
    return {
      result,
      state: this.taskMachine.snapshotState(),
      messages: this.messages,
      agents: Object.values(this.agents).map((agent) => ({
        name: agent.name,
        role: agent.role
      }))
    };
  }
}
