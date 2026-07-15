import { describe, expect, it } from "vitest";
import {
  reduceMotionPresence,
  resolveMotionPresenceDuration,
  type MotionPresenceState
} from "../apps/desktop/src/renderer/motion-presence";

describe("motion presence state", () => {
  it("enters from an unmounted state and settles", () => {
    const initial: MotionPresenceState<string> = { value: null, phase: "exited" };
    const entering = reduceMotionPresence(initial, { type: "show", value: "dialog" });

    expect(entering).toEqual({ value: "dialog", phase: "entering" });
    expect(reduceMotionPresence(entering, { type: "finish" })).toEqual({ value: "dialog", phase: "entered" });
  });

  it("retains content through exit and unmounts after settling", () => {
    const entered: MotionPresenceState<string> = { value: "dialog", phase: "entered" };
    const exiting = reduceMotionPresence(entered, { type: "hide" });

    expect(exiting).toEqual({ value: "dialog", phase: "exiting" });
    expect(reduceMotionPresence(exiting, { type: "finish" })).toEqual({ value: null, phase: "exited" });
  });

  it("restarts entry when reopened during exit", () => {
    const exiting: MotionPresenceState<string> = { value: "old", phase: "exiting" };

    expect(reduceMotionPresence(exiting, { type: "show", value: "new" })).toEqual({
      value: "new",
      phase: "entering"
    });
  });

  it("settles immediately when reduced motion is requested", () => {
    expect(resolveMotionPresenceDuration(180, true)).toBe(0);
    expect(resolveMotionPresenceDuration(180, false)).toBe(180);
  });
});
