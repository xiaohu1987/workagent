import { describe, expect, it } from "vitest";
import { resolveDeferredToolGroup } from "../apps/desktop/src/renderer/timeline/deferred-tool-group";

type Call = {
  id: string;
  completedAt?: string | null;
  status?: "pending" | "running" | "completed" | "failed" | "denied" | "blocked";
};

describe("deferred runtime tool group", () => {
  it("keeps a batch that already holds a finished call in the transcript", () => {
    // The group was hidden while its calls were live and came back as soon as the next assistant
    // message arrived, so an interval that mixed finished and running calls flickered out of the
    // middle of the transcript. Finished calls are history now and never deferred.
    const calls: Call[] = [
      { id: "a", completedAt: "2026-09-24T02:00:05.000Z" },
      { id: "b" }
    ];
    expect(resolveDeferredToolGroup(calls, false)).toBeNull();
    expect(resolveDeferredToolGroup(calls, true)).toBeNull();
  });

  it("does not defer terminal calls without a completion timestamp", () => {
    const calls: Call[] = [
      { id: "completed", status: "completed", completedAt: null },
      { id: "failed", status: "failed" }
    ];
    expect(resolveDeferredToolGroup(calls, false)).toBeNull();
    expect(resolveDeferredToolGroup(calls, true)).toBeNull();
  });

  it("defers only a batch in which every call is still running", () => {
    const calls: Call[] = [
      { id: "a", status: "running" },
      { id: "b", status: "pending" }
    ];
    expect(resolveDeferredToolGroup(calls, false)).toEqual(calls);
    expect(resolveDeferredToolGroup(calls, true)).toBeNull();
  });

  it("keeps a running call without a completion timestamp in the live batch", () => {
    const calls: Call[] = [{ id: "a", status: "running", completedAt: null }];
    expect(resolveDeferredToolGroup(calls, false)).toEqual(calls);
  });

  it("renders an empty batch instead of hiding it", () => {
    expect(resolveDeferredToolGroup([] as Call[], false)).toBeNull();
  });
});
