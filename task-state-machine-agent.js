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

  async advance(note = "") {
    if (this.taskState.phase === "done") {
      return this.snapshotState();
    }

    if (note) {
      this.taskState.completedSteps.push({
        phase: this.taskState.phase,
        step: this.taskState.currentStep,
        note
      });
    }

    if (this.taskState.phase === "execution") {
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

    this.taskState.phase = NEXT_PHASE[this.taskState.phase];
    this.taskState.currentStep = this.stepForPhase(this.taskState.phase);
    this.taskState.expectedAction = PHASE_EXPECTATIONS[this.taskState.phase];
    await this.remember("working", "phase", this.taskState.phase);
    await this.saveState();
    return this.snapshotState();
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
      "Правила конечного автомата:",
      "planning -> execution -> validation -> done",
      "Если paused=true, не начинай заново: объясни, где остановились и какое действие ожидается."
    ].join("\n");
  }

  async chat(userInput) {
    const statePrompt = this.buildStatePrompt();
    const content = [
      statePrompt,
      "",
      `Запрос пользователя: ${userInput}`
    ].join("\n");
    return super.chat(content);
  }

  createLayeredMemoryMockCompletion(userInput, contextTokens) {
    const state = this.taskState;
    const answer = state.paused
      ? `Пауза сохранена. Мы на этапе ${state.phase}, текущий шаг: "${state.currentStep}". Ожидаемое действие: ${state.expectedAction}.`
      : [
          `Этап: ${state.phase}.`,
          `Текущий шаг: ${state.currentStep}.`,
          `Ожидаемое действие: ${state.expectedAction}.`,
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
