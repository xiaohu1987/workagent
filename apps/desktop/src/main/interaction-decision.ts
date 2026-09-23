import type { ApprovalRequest, UserInputQuestion } from "@shared-types";

/**
 * Shared countdown window for interactions that are allowed to resolve without
 * the user. Keeping it in one place makes the 30s contract testable.
 */
export const INTERACTION_TIMEOUT_MS = 30_000;

export interface InteractionTimeoutPlan {
  /** Milliseconds until the interaction is auto-resolved, or null to wait indefinitely. */
  timeoutMs: number | null;
  /** Answers submitted on the user's behalf when the countdown reaches zero. */
  defaultAnswers: Record<string, string> | null;
}

/**
 * Keep at most one recommended option per question so the timeout fallback is
 * deterministic. Extra recommended flags are demoted instead of rejected, which
 * matches the "降级为第一项" rule for malformed input.
 */
export function normalizeRecommendedOptions(questions: UserInputQuestion[]): UserInputQuestion[] {
  return questions.map((question) => {
    const options = question.options;
    if (!options?.length) return question;
    let seenRecommended = false;
    return {
      ...question,
      options: options.map((option) => {
        if (!option.recommended) return option;
        if (seenRecommended) return { ...option, recommended: false };
        seenRecommended = true;
        return option;
      })
    };
  });
}

/**
 * Answers submitted when the countdown expires: the recommended option, else the
 * first option. Returns null as soon as one question cannot be answered from its
 * options, which disables the timeout fallback for the whole prompt.
 */
export function resolveDefaultAnswers(questions: UserInputQuestion[]): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const question of normalizeRecommendedOptions(questions)) {
    const option = question.options?.find((entry) => entry.recommended) ?? question.options?.[0];
    if (!option) return null;
    answers[question.id] = option.id;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

/**
 * Decide whether a user-input prompt may be auto-answered, and with what.
 *
 * Plan clarifications are resolved by the plan stage rather than a timer, and a
 * prompt without selectable options cannot produce a default answer at all. In
 * both cases the countdown fallback stays disabled instead of guessing.
 */
export function planInteractionTimeout(input: {
  kind: "generic" | "gpa_plan_clarification";
  questions: UserInputQuestion[];
  requestedTimeoutMs?: number;
  /**
   * Safety boundary for user-input decisions. An irreversible decision must be
   * answered by the user, so it never gets a countdown and never submits a
   * default answer on the user's behalf.
   */
  allowsAutoSelection?: boolean;
}): InteractionTimeoutPlan {
  if (input.allowsAutoSelection === false) {
    return { timeoutMs: null, defaultAnswers: null };
  }
  const defaultAnswers = input.kind === "generic" ? resolveDefaultAnswers(input.questions) : null;
  const requested = input.requestedTimeoutMs;
  if (!defaultAnswers) {
    return { timeoutMs: requested && requested > 0 ? requested : null, defaultAnswers: null };
  }
  if (requested !== undefined && requested <= 0) {
    return { timeoutMs: null, defaultAnswers: null };
  }
  return { timeoutMs: requested ?? INTERACTION_TIMEOUT_MS, defaultAnswers };
}

/**
 * Safety boundary: approvals that require explicit authorization guard
 * irreversible work, so they never expire on their own and must be answered by
 * the user. Regular permission approvals keep the shared timeout.
 */
export function resolveApprovalExpiresAt(
  kind: ApprovalRequest["kind"],
  now: number = Date.now()
): string | null {
  if (kind === "explicit_authorization") return null;
  return new Date(now + INTERACTION_TIMEOUT_MS).toISOString();
}
