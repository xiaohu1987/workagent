import { describe, expect, it } from "vitest";
import { shouldRevealBrowserWorkspace } from "../apps/desktop/src/renderer/workspace/browser-preferences";

describe("browser workspace preferences", () => {
  it("reveals the selected thread browser workspace only for non-silent openings", () => {
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-1",
      payload: { action: "open", silentBrowserOpen: false }
    }, "thread-1")).toBe(true);
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-1",
      payload: { action: "open", silentBrowserOpen: true }
    }, "thread-1")).toBe(false);
  });

  it("does not reveal the browser workspace for background threads or non-opening updates", () => {
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-2",
      payload: { action: "open", silentBrowserOpen: false }
    }, "thread-1")).toBe(false);
    expect(shouldRevealBrowserWorkspace({
      type: "browser.updated",
      threadId: "thread-1",
      payload: { action: "navigate", silentBrowserOpen: false }
    }, "thread-1")).toBe(false);
  });
});
