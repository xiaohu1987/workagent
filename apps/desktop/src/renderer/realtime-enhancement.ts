import type { RuntimeEvent } from "@shared-types";

export type RealtimeEnhancementPhase =
  | "idle"
  | "thinking"
  | "generating"
  | "executing"
  | "completed"
  | "interrupted"
  | "failed";

export type RealtimeReactionMood = "neutral" | "focus" | "active" | "success" | "warning";

export type RealtimeTextReactionInput = Pick<RealtimeSceneState, "phase" | "userText" | "assistantText" | "activeTool">;

export interface RealtimeTextReaction {
  mood: RealtimeReactionMood;
  accent: string;
  intensity: number;
  pulse: boolean;
}

export interface RealtimeSceneState {
  threadId: string | null;
  turnRunId: string | null;
  generation: number;
  phase: RealtimeEnhancementPhase;
  userText: string;
  assistantText: string;
  activeTool: string | null;
  updatedAt: string;
  reaction: RealtimeTextReaction;
}

export interface RealtimeEnhancementConfig {
  enabled: boolean;
  threadId: string | null;
  theme?: "default";
}

export type RealtimeTextReactionPolicy = (input: RealtimeTextReactionInput) => RealtimeTextReaction;

type RealtimeInterrupt = (threadId: string) => Promise<void> | void;
type RealtimeStateListener = (state: RealtimeSceneState) => void;

const RUNNING_PHASES = new Set<RealtimeEnhancementPhase>([
  "thinking",
  "generating",
  "executing"
]);

const DEFAULT_REACTION: RealtimeTextReaction = {
  mood: "neutral",
  accent: "#aeb8c8",
  intensity: 0,
  pulse: false
};

function now(): string {
  return new Date().toISOString();
}

function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function clampIntensity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export const realtimeTextReactionPolicy: RealtimeTextReactionPolicy = ({
  phase,
  userText,
  assistantText,
  activeTool
}) => {
  const text = `${userText}\n${assistantText}`.toLowerCase();

  if (phase === "failed") {
    return { mood: "warning", accent: "#ff9e8a", intensity: 0.92, pulse: true };
  }
  if (phase === "interrupted") {
    return { mood: "neutral", accent: "#aeb8c8", intensity: 0.18, pulse: false };
  }
  if (phase === "completed") {
    return { mood: "success", accent: "#9be7b1", intensity: 0.46, pulse: false };
  }
  if (phase === "executing") {
    return { mood: "active", accent: "#ffcb7a", intensity: 0.78, pulse: true };
  }
  if (phase === "thinking" || phase === "generating") {
    if (includesAny(text, ["error", "failed", "failure", "bug", "错误", "失败", "异常"])) {
      return { mood: "warning", accent: "#ffb08f", intensity: 0.66, pulse: true };
    }
    if (includesAny(text, ["done", "success", "完成", "成功", "已解决"])) {
      return { mood: "success", accent: "#a8e6b8", intensity: 0.58, pulse: false };
    }
    return {
      mood: "focus",
      accent: activeTool ? "#ffcb7a" : "#8cc8ff",
      intensity: activeTool ? 0.72 : 0.52,
      pulse: true
    };
  }

  return DEFAULT_REACTION;
};

export function createRealtimeSceneState(threadId: string | null = null, generation = 0): RealtimeSceneState {
  return {
    threadId,
    turnRunId: null,
    generation,
    phase: "idle",
    userText: "",
    assistantText: "",
    activeTool: null,
    updatedAt: now(),
    reaction: DEFAULT_REACTION
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readTurnRunId(payload: Record<string, unknown>): string | null {
  return isString(payload.turnRunId) ? payload.turnRunId : null;
}

function readThreadStatus(payload: Record<string, unknown>): string | null {
  const thread = payload.thread;
  if (!thread || typeof thread !== "object") return null;
  const status = (thread as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

export class RealtimeEnhancementController {
  #config: RealtimeEnhancementConfig;
  #enabled: boolean;
  #generation: number;
  #currentTurnRunId: string | null = null;
  #state: RealtimeSceneState;
  #listeners = new Set<RealtimeStateListener>();
  #ignoredTurnRunIds = new Set<string>();
  #interrupt: RealtimeInterrupt | undefined;

  public constructor(
    config: RealtimeEnhancementConfig,
    options: { interrupt?: RealtimeInterrupt } = {}
  ) {
    this.#config = { ...config };
    this.#enabled = config.enabled;
    this.#generation = 0;
    this.#state = createRealtimeSceneState(config.threadId, this.#generation);
    this.#interrupt = options.interrupt;
  }

  public start(): void {
    this.#enabled = true;
    this.#emit();
  }

  public stop(): void {
    this.#enabled = false;
    this.#generation += 1;
    this.#currentTurnRunId = null;
    this.#ignoredTurnRunIds.clear();
    this.#state = createRealtimeSceneState(this.#config.threadId, this.#generation);
    this.#emit();
  }

  public configure(config: Partial<RealtimeEnhancementConfig>): void {
    const threadChanged = config.threadId !== undefined && config.threadId !== this.#config.threadId;
    const enabledChanged = config.enabled !== undefined && config.enabled !== this.#enabled;
    this.#config = { ...this.#config, ...config };
    if (config.enabled !== undefined) this.#enabled = config.enabled;
    if (threadChanged) {
      this.#generation += 1;
      this.#currentTurnRunId = null;
      this.#ignoredTurnRunIds.clear();
      this.#state = createRealtimeSceneState(this.#config.threadId, this.#generation);
    }
    if (enabledChanged && !this.#enabled) {
      this.#generation += 1;
      this.#currentTurnRunId = null;
      this.#ignoredTurnRunIds.clear();
      this.#state = createRealtimeSceneState(this.#config.threadId, this.#generation);
    }
    if (threadChanged || enabledChanged) this.#emit();
  }

  public setInterruptHandler(interrupt: RealtimeInterrupt | undefined): void {
    this.#interrupt = interrupt;
  }

  public get enabled(): boolean {
    return this.#enabled;
  }

  public get state(): RealtimeSceneState {
    return this.getState();
  }

  public get isActive(): boolean {
    return RUNNING_PHASES.has(this.#state.phase);
  }

  public getState(): RealtimeSceneState {
    return {
      ...this.#state,
      reaction: { ...this.#state.reaction }
    };
  }

  public subscribe(listener: RealtimeStateListener): () => void {
    this.#listeners.add(listener);
    listener(this.getState());
    return () => this.#listeners.delete(listener);
  }

  public async submitText(text: string, threadId = this.#config.threadId): Promise<number> {
    if (threadId !== this.#config.threadId) this.configure({ threadId });
    if (!this.#enabled || !threadId) return this.#generation;

    if (this.isActive) await this.interrupt();

    this.#generation += 1;
    this.#currentTurnRunId = null;
    this.#setState({
      threadId,
      generation: this.#generation,
      turnRunId: null,
      phase: "thinking",
      userText: text.trim(),
      assistantText: "",
      activeTool: null
    });
    return this.#generation;
  }

  public async interrupt(): Promise<void> {
    if (!this.#enabled) return;
    const threadId = this.#config.threadId;
    this.#generation += 1;
    this.sealCurrentTurn();
    this.#setState({
      generation: this.#generation,
      phase: "interrupted",
      turnRunId: this.#state.turnRunId,
      activeTool: null
    });
    if (threadId && this.#interrupt) await this.#interrupt(threadId);
  }

  public reset(): void {
    this.#generation += 1;
    this.#currentTurnRunId = null;
    this.#ignoredTurnRunIds.clear();
    this.#state = createRealtimeSceneState(this.#config.threadId, this.#generation);
    this.#emit();
  }

  public returnToIdle(turnRunId: string | null = this.#state.turnRunId): void {
    if (!this.#enabled || this.#state.phase !== "completed") return;
    if (turnRunId && this.#state.turnRunId !== turnRunId) return;
    this.#setState({
      phase: "idle",
      turnRunId: null,
      userText: "",
      assistantText: "",
      activeTool: null
    });
  }

  public handleRuntimeEvent(event: RuntimeEvent): void {
    if (!this.#enabled || event.threadId !== this.#config.threadId) return;

    const payload = event.payload ?? {};
    const turnRunId = readTurnRunId(payload);
    switch (event.type) {
      case "assistant.draft.updated": {
        if (!turnRunId || !this.acceptTurn(turnRunId)) return;
        this.#setState({
          turnRunId,
          phase: "generating",
          assistantText: typeof payload.content === "string" ? payload.content : this.#state.assistantText,
          activeTool: null
        });
        return;
      }
      case "assistant.completed": {
        if (!turnRunId || !this.matchesCurrentTurn(turnRunId)) return;
        const discarded = payload.discarded === true;
        if (discarded) {
          this.sealCurrentTurn();
          this.#setState({ turnRunId, phase: "interrupted", activeTool: null });
        }
        return;
      }
      case "tool.started": {
        if (!turnRunId || !this.acceptTurn(turnRunId)) return;
        this.#setState({
          turnRunId,
          phase: "executing",
          activeTool: typeof payload.toolName === "string" ? payload.toolName : "tool"
        });
        return;
      }
      case "tool.completed": {
        if (!turnRunId || !this.matchesCurrentTurn(turnRunId)) return;
        this.#setState({
          turnRunId,
          phase: this.#state.assistantText ? "generating" : "thinking",
          activeTool: null
        });
        return;
      }
      case "agent.awaiting_model": {
        if (!turnRunId || !this.acceptTurn(turnRunId)) return;
        this.#setState({ turnRunId, phase: "thinking", activeTool: null });
        return;
      }
      case "thread.updated": {
        if (!this.#currentTurnRunId) return;
        const status = readThreadStatus(payload);
        if (status === "failed") {
          this.sealCurrentTurn();
          this.#setState({ phase: "failed", activeTool: null });
        } else if (status === "completed") {
          const turnRunId = this.#currentTurnRunId;
          this.sealCurrentTurn();
          this.#setState({ turnRunId, phase: "completed", activeTool: null });
        }
        return;
      }
      default:
        return;
    }
  }

  private acceptTurn(turnRunId: string): boolean {
    if (this.#ignoredTurnRunIds.has(turnRunId)) return false;
    if (this.#currentTurnRunId) return this.#currentTurnRunId === turnRunId;
    if (!RUNNING_PHASES.has(this.#state.phase)) return false;
    this.#currentTurnRunId = turnRunId;
    return true;
  }

  private matchesCurrentTurn(turnRunId: string): boolean {
    return this.#currentTurnRunId === turnRunId;
  }

  private sealCurrentTurn(): void {
    if (!this.#currentTurnRunId) return;
    this.#ignoredTurnRunIds.add(this.#currentTurnRunId);
    this.#currentTurnRunId = null;
    while (this.#ignoredTurnRunIds.size > 64) {
      const oldest = this.#ignoredTurnRunIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.#ignoredTurnRunIds.delete(oldest);
    }
  }

  #setState(patch: Partial<RealtimeSceneState>): void {
    const next = { ...this.#state, ...patch, updatedAt: now() };
    next.reaction = realtimeTextReactionPolicy(next);
    this.#state = next;
    this.#emit();
  }

  #emit(): void {
    const state = this.getState();
    for (const listener of this.#listeners) listener(state);
  }
}
