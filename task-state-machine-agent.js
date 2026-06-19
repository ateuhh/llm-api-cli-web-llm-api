import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { LayeredMemoryAgent } from "./layered-memory-agent.js";

const PHASES = ["planning", "execution", "validation", "done"];
const NEXT_PHASE = {
  planning: "execution",
  execution: "validation",
  validation: "done",
  done: "done"
};
const ALLOWED_TRANSITIONS = {
  planning: ["execution"],
  execution: ["validation"],
  validation: ["done"],
  done: []
};

const PHASE_EXPECTATIONS = {
  planning: "Сформулировать план и подтвердить шаги.",
  execution: "Выполнить текущий шаг.",
  validation: "Проверить результат и найти ошибки.",
  done: "Задача завершена."
};

export class TaskStateMachineAgent extends LayeredMemoryAgent {
  constructor({
    statePath = "./task-state.json",
    ...options
  } = {}) {
    super({
      ...options,
      systemPrompt:
        "Ты ассистент с формализованным состоянием задачи. Всегда учитывай phase, currentStep и expectedAction."
    });

    this.statePath = statePath;
    this.taskState = this.createInitialState();
  }

  createInitialState() {
    return {
      phase: "planning",
      currentStep: "Определить задачу и план работ",
      expectedAction: PHASE_EXPECTATIONS.planning,
      paused: false,
      taskName: "",
      plan: [],
      invariants: [],
      transitionHistory: [],
      completedSteps: [],
      validationNotes: []
    };
  }

  async loadState() {
    try {
      const rawState = await readFile(this.statePath, "utf8");
      const savedState = JSON.parse(rawState);
      this.taskState = {
        ...this.createInitialState(),
        ...savedState
      };
      this.validateState();
      return this.snapshotState();
    } catch (error) {
      if (error.code === "ENOENT") {
        await this.saveState();
        return this.snapshotState();
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Не удалось загрузить ${this.statePath}: поврежден JSON.`);
      }

      throw error;
    }
  }

  async saveState() {
    const temporaryPath = `${this.statePath}.tmp`;
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(this.taskState, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.statePath);
  }

  validateState() {
    if (!PHASES.includes(this.taskState.phase)) {
      throw new Error(`Некорректный phase: ${this.taskState.phase}`);
    }
  }

  snapshotState() {
    return JSON.parse(JSON.stringify(this.taskState));
  }

  async addInvariant({ type, key, value, description }) {
    const invariant = {
      id: crypto.randomUUID(),
      type,
      key,
      value,
      description: description || `${key}: ${value}`
    };
    this.taskState.invariants.push(invariant);
    await this.saveState();
    return invariant;
  }

  async removeInvariant(id) {
    this.taskState.invariants = this.taskState.invariants.filter(
      (invariant) => invariant.id !== id
    );
    await this.saveState();
  }

  listInvariants() {
    return this.taskState.invariants.map((invariant) => ({ ...invariant }));
  }

  async startTask(taskName, plan = []) {
    this.taskState = {
      ...this.createInitialState(),
      taskName,
      plan,
      currentStep: plan[0] || "Согласовать план",
      expectedAction: PHASE_EXPECTATIONS.planning
    };
    await this.remember("working", "task", taskName);
    await this.remember("working", "phase", this.taskState.phase);
    await this.saveState();
  }

  async pause(reason = "Пауза по запросу пользователя") {
    this.taskState.paused = true;
    this.taskState.expectedAction = `Продолжить с этапа ${this.taskState.phase}. Причина паузы: ${reason}`;
    await this.saveState();
  }

  async resume() {
    this.taskState.paused = false;
    this.taskState.expectedAction = PHASE_EXPECTATIONS[this.taskState.phase];
    await this.saveState();
  }

  canTransitionTo(targetPhase) {
    return ALLOWED_TRANSITIONS[this.taskState.phase]?.includes(targetPhase) || false;
  }

  assertTransitionAllowed(targetPhase) {
    if (!PHASES.includes(targetPhase)) {
      throw new Error(`Недопустимое состояние "${targetPhase}". Разрешены: ${PHASES.join(", ")}.`);
    }

    if (this.taskState.paused) {
      throw new Error(
        `Нельзя менять состояние во время паузы. Текущий этап: ${this.taskState.phase}. Сначала выполните /resume.`
      );
    }

    if (!this.canTransitionTo(targetPhase)) {
      const allowed = ALLOWED_TRANSITIONS[this.taskState.phase];
      throw new Error(
        [
          `Переход ${this.taskState.phase} -> ${targetPhase} запрещен.`,
          allowed.length > 0
            ? `Разрешенный следующий этап: ${allowed.join(", ")}.`
            : "Из текущего этапа нет дальнейших переходов.",
          "Нельзя перепрыгивать этапы жизненного цикла задачи."
        ].join(" ")
      );
    }
  }

  async transitionTo(targetPhase, note = "", { recordCompletedStep = true } = {}) {
    this.assertTransitionAllowed(targetPhase);

    const from = this.taskState.phase;
    if (note && recordCompletedStep) {
      this.taskState.completedSteps.push({
        phase: from,
        step: this.taskState.currentStep,
        note
      });
    }
    this.taskState.transitionHistory.push({
      from,
      to: targetPhase,
      note,
      at: new Date().toISOString()
    });
    this.taskState.phase = targetPhase;
    this.taskState.currentStep = this.stepForPhase(targetPhase);
    this.taskState.expectedAction = PHASE_EXPECTATIONS[targetPhase];
    await this.remember("working", "phase", this.taskState.phase);
    await this.saveState();
    return this.snapshotState();
  }

  async advance(note = "") {
    if (this.taskState.phase === "done") {
      return this.snapshotState();
    }

    if (this.taskState.phase === "execution") {
      if (this.taskState.paused) {
        throw new Error(
          `Нельзя менять состояние во время паузы. Текущий этап: ${this.taskState.phase}. Сначала выполните /resume.`
        );
      }
      if (note) {
        this.taskState.completedSteps.push({
          phase: this.taskState.phase,
          step: this.taskState.currentStep,
          note
        });
      }
      const nextStepIndex = this.taskState.completedSteps.filter(
        (step) => step.phase === "execution"
      ).length;
      const nextStep = this.taskState.plan[nextStepIndex];

      if (nextStep) {
        this.taskState.currentStep = nextStep;
        this.taskState.expectedAction = PHASE_EXPECTATIONS.execution;
        await this.saveState();
        return this.snapshotState();
      }
    }

    return this.transitionTo(NEXT_PHASE[this.taskState.phase], note, {
      recordCompletedStep: false
    });
  }

  stepForPhase(phase) {
    if (phase === "execution") {
      return this.taskState.plan[0] || "Выполнить задачу";
    }
    if (phase === "validation") {
      return "Проверить выполненные шаги";
    }
    if (phase === "done") {
      return "Задача завершена";
    }
    return "Определить задачу и план работ";
  }

  buildStatePrompt() {
    return [
      "Состояние задачи:",
      JSON.stringify(this.taskState, null, 2),
      "",
      "Инварианты задачи:",
      JSON.stringify(this.taskState.invariants, null, 2),
      "",
      "Правила конечного автомата:",
      "planning -> execution -> validation -> done",
      `Разрешённые переходы: ${JSON.stringify(ALLOWED_TRANSITIONS)}.`,
      "Запрещено перепрыгивать этапы: нельзя делать execution до planning, нельзя done без validation.",
      "Если paused=true, не начинай заново: объясни, где остановились и какое действие ожидается.",
      "Никогда не предлагай решения, нарушающие инварианты. При конфликте явно откажись и объясни, какой инвариант нарушен."
    ].join("\n");
  }

  async chat(userInput) {
    const conflict = this.checkInvariantConflict(userInput);

    if (conflict) {
      const refusal = [
        "Отказываюсь предлагать это решение, потому что оно нарушает инвариант задачи.",
        `Инвариант: ${conflict.invariant.description}.`,
        `Конфликт: ${conflict.reason}.`,
        "Предложите вариант, который сохраняет принятые ограничения."
      ].join(" ");
      this.addShortMessage({ role: "user", content: userInput });
      this.addShortMessage({ role: "assistant", content: refusal });
      await this.saveMemory();
      await this.saveState();
      return refusal;
    }

    const statePrompt = this.buildStatePrompt();
    const content = [
      statePrompt,
      "",
      `Запрос пользователя: ${userInput}`
    ].join("\n");
    return super.chat(content);
  }

  checkInvariantConflict(userInput) {
    const normalizedInput = userInput.toLowerCase();

    for (const invariant of this.taskState.invariants) {
      const normalizedValue = String(invariant.value || "").toLowerCase();
      const normalizedKey = String(invariant.key || "").toLowerCase();

      if (invariant.type === "forbid" && normalizedInput.includes(normalizedValue)) {
        return {
          invariant,
          reason: `запрос содержит запрещенное значение "${invariant.value}"`
        };
      }

      if (
        invariant.type === "fixed" &&
        normalizedKey.includes("архитект") &&
        normalizedValue.includes("rest") &&
        normalizedInput.includes("graphql")
      ) {
        return {
          invariant,
          reason: "запрос предлагает GraphQL вместо зафиксированной REST-архитектуры"
        };
      }

      if (
        invariant.type === "fixed" &&
        normalizedKey.includes("база") &&
        normalizedInput.includes("mongodb") &&
        !normalizedValue.includes("mongodb")
      ) {
        return {
          invariant,
          reason: `запрос предлагает MongoDB вместо зафиксированного значения "${invariant.value}"`
        };
      }
    }

    return null;
  }

  createLayeredMemoryMockCompletion(userInput, contextTokens) {
    const state = this.taskState;
    const answer = state.paused
      ? `Пауза сохранена. Мы на этапе ${state.phase}, текущий шаг: "${state.currentStep}". Ожидаемое действие: ${state.expectedAction}.`
      : [
          `Этап: ${state.phase}.`,
          `Текущий шаг: ${state.currentStep}.`,
          `Ожидаемое действие: ${state.expectedAction}.`,
          `Инварианты: ${state.invariants.map((invariant) => invariant.description).join("; ") || "не заданы"}.`,
          `Продолжать можно без повторного объяснения задачи.`
        ].join(" ");
    const completionTokens = Math.ceil(answer.length / 3.5);

    return {
      answer,
      usage: {
        prompt_tokens: contextTokens,
        completion_tokens: completionTokens,
        total_tokens: contextTokens + completionTokens
      }
    };
  }
}
