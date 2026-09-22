import { describe, expect, it } from "vitest";
import type { ApprovalRequest, UserInputQuestion } from "@shared-types";
import {
  INTERACTION_TIMEOUT_MS,
  normalizeRecommendedOptions,
  planInteractionTimeout,
  resolveApprovalExpiresAt,
  resolveDefaultAnswers
} from "../apps/desktop/src/main/interaction-decision";

function question(id: string, options?: UserInputQuestion["options"]): UserInputQuestion {
  return { id, label: id, prompt: `请选择 ${id}`, options } as UserInputQuestion;
}

const recommendedQuestions = [
  question("q1", [
    { id: "a", label: "A" },
    { id: "b", label: "B", recommended: true }
  ])
];

describe("normalizeRecommendedOptions", () => {
  it("keeps exactly one recommended option and demotes the extras", () => {
    const [normalized] = normalizeRecommendedOptions([
      question("q1", [
        { id: "a", label: "A" },
        { id: "b", label: "B", recommended: true },
        { id: "c", label: "C", recommended: true }
      ])
    ]);
    expect(normalized.options?.filter((option) => option.recommended).map((option) => option.id)).toEqual(["b"]);
  });

  it("accepts the no-recommendation state and is idempotent", () => {
    const input = [question("q1", [{ id: "a", label: "A" }, { id: "b", label: "B" }])];
    const once = normalizeRecommendedOptions(input);
    expect(once[0].options?.some((option) => option.recommended)).toBe(false);
    expect(normalizeRecommendedOptions(once)).toEqual(once);
  });
});

describe("resolveDefaultAnswers", () => {
  it("prefers the recommended option and falls back to the first one", () => {
    expect(
      resolveDefaultAnswers([
        question("q1", [{ id: "a", label: "A" }, { id: "b", label: "B", recommended: true }]),
        question("q2", [{ id: "c", label: "C" }, { id: "d", label: "D" }])
      ])
    ).toEqual({ q1: "b", q2: "c" });
  });

  it("returns null when a question cannot be answered from its options", () => {
    expect(resolveDefaultAnswers([question("q1", [{ id: "a", label: "A" }]), question("q2")])).toBeNull();
  });
});

describe("planInteractionTimeout", () => {
  it("arms the shared countdown with the fallback answers for a generic decision", () => {
    expect(planInteractionTimeout({ kind: "generic", questions: recommendedQuestions })).toEqual({
      timeoutMs: INTERACTION_TIMEOUT_MS,
      defaultAnswers: { q1: "b" }
    });
  });

  it("honours an explicit window and disables the fallback for a non-positive one", () => {
    expect(planInteractionTimeout({ kind: "generic", questions: recommendedQuestions, requestedTimeoutMs: 5_000 })).toEqual({
      timeoutMs: 5_000,
      defaultAnswers: { q1: "b" }
    });
    expect(planInteractionTimeout({ kind: "generic", questions: recommendedQuestions, requestedTimeoutMs: 0 })).toEqual({
      timeoutMs: null,
      defaultAnswers: null
    });
  });

  it("leaves plan clarifications waiting for the user instead of timing out", () => {
    expect(planInteractionTimeout({ kind: "gpa_plan_clarification", questions: recommendedQuestions })).toEqual({
      timeoutMs: null,
      defaultAnswers: null
    });
  });

  it("never auto-answers an irreversible decision", () => {
    expect(
      planInteractionTimeout({
        kind: "generic",
        questions: recommendedQuestions,
        requestedTimeoutMs: 5_000,
        allowsAutoSelection: false
      })
    ).toEqual({ timeoutMs: null, defaultAnswers: null });
  });

  it("plans deterministically so a single decision can only expire once", () => {
    const first = planInteractionTimeout({ kind: "generic", questions: recommendedQuestions });
    const second = planInteractionTimeout({ kind: "generic", questions: recommendedQuestions });
    expect(second).toEqual(first);
    expect(first.defaultAnswers).not.toBe(second.defaultAnswers);
  });
});

describe("resolveApprovalExpiresAt", () => {
  it("protects explicit authorization and lets an ordinary approval expire", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const ordinaryKind = "permission" as unknown as ApprovalRequest["kind"];
    expect(resolveApprovalExpiresAt("explicit_authorization", now)).toBeNull();
    expect(resolveApprovalExpiresAt(ordinaryKind, now)).toBe(new Date(now + INTERACTION_TIMEOUT_MS).toISOString());
  });
});
