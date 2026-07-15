import { useEffect, useRef, useState } from "react";

export type MotionPresencePhase = "entering" | "entered" | "exiting" | "exited";

export type MotionPresenceState<T> = {
  value: T | null;
  phase: MotionPresencePhase;
};

export type MotionSwitchDirection = "forward" | "backward";

export type MotionSwitchState<T> = {
  current: T;
  leaving: T | null;
  direction: MotionSwitchDirection;
};

export type MotionPresenceAction<T> =
  | { type: "show"; value: T }
  | { type: "hide" }
  | { type: "finish" };

export function reduceMotionPresence<T>(
  state: MotionPresenceState<T>,
  action: MotionPresenceAction<T>
): MotionPresenceState<T> {
  if (action.type === "show") {
    const shouldEnter = state.phase === "exited" || state.phase === "exiting";
    return {
      value: action.value,
      phase: shouldEnter ? "entering" : "entered"
    };
  }

  if (action.type === "hide") {
    return state.value === null || state.phase === "exited"
      ? { value: null, phase: "exited" }
      : { value: state.value, phase: "exiting" };
  }

  if (state.phase === "entering") {
    return { value: state.value, phase: "entered" };
  }
  if (state.phase === "exiting") {
    return { value: null, phase: "exited" };
  }
  return state;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function resolveMotionPresenceDuration(duration: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : duration;
}

export function useMotionPresence<T>(value: T | null | undefined, duration = 180): MotionPresenceState<T> {
  const [state, setState] = useState<MotionPresenceState<T>>(() => value == null
    ? { value: null, phase: "exited" }
    : { value, phase: "entering" });
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setState((current) => reduceMotionPresence(
      current,
      value == null ? { type: "hide" } : { type: "show", value }
    ));

    const delay = resolveMotionPresenceDuration(duration, prefersReducedMotion());
    timerRef.current = window.setTimeout(() => {
      setState((current) => reduceMotionPresence(current, { type: "finish" }));
      timerRef.current = null;
    }, delay);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [duration, value]);

  if (value != null) {
    return {
      value,
      phase: state.phase === "exited" || state.phase === "exiting" ? "entering" : state.phase
    };
  }
  if (state.value !== null && (state.phase === "entered" || state.phase === "entering")) {
    return { value: state.value, phase: "exiting" };
  }
  return state;
}

/** Keeps the previous keyed view mounted long enough for a directional swap animation. */
export function useMotionSwitch<T>(
  value: T,
  getDirection: (from: T, to: T) => MotionSwitchDirection,
  duration = 180
): MotionSwitchState<T> {
  const [state, setState] = useState<MotionSwitchState<T>>({
    current: value,
    leaving: null,
    direction: "forward"
  });
  const currentRef = useRef(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const from = currentRef.current;
    if (Object.is(value, from)) {
      return;
    }
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const direction = getDirection(from, value);
    currentRef.current = value;
    setState({ current: value, leaving: from, direction });
    const delay = resolveMotionPresenceDuration(duration, prefersReducedMotion());
    timerRef.current = window.setTimeout(() => {
      setState((current) => ({ ...current, leaving: null }));
      timerRef.current = null;
    }, delay);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [duration, getDirection, value]);

  return state;
}
