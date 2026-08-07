import { useEffect, useRef, useState } from "react";
import type { RuntimeEvent } from "@shared-types";
import {
  RealtimeEnhancementController,
  type RealtimeSceneState
} from "../realtime-enhancement";

type Options = {
  threadId: string | null;
  defaultEnabled?: boolean;
  onInterrupt?: (threadId: string) => Promise<void> | void;
};

export function useRealtimeEnhancement({ threadId, defaultEnabled = false, onInterrupt }: Options) {
  const controllerRef = useRef<RealtimeEnhancementController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new RealtimeEnhancementController({
      enabled: defaultEnabled,
      threadId
    }, { interrupt: onInterrupt });
  }
  const controller = controllerRef.current;
  const [enabled, setEnabledState] = useState(defaultEnabled);
  const [scene, setScene] = useState<RealtimeSceneState>(() => controller.getState());

  useEffect(() => controller.subscribe(setScene), [controller]);

  useEffect(() => {
    controller.setInterruptHandler(onInterrupt);
  }, [controller, onInterrupt]);

  useEffect(() => {
    const dispose = window.codexh.onRuntimeEvent((event) => {
      controller.handleRuntimeEvent(event as RuntimeEvent);
    });
    return dispose;
  }, [controller]);

  useEffect(() => {
    controller.configure({ threadId, enabled });
  }, [controller, enabled, threadId]);

  function setEnabled(next: boolean) {
    setEnabledState(next);
    if (next) controller.start();
    else controller.stop();
  }

  return {
    controller,
    enabled,
    setEnabled,
    scene,
    submitText: (text: string, targetThreadId?: string | null) =>
      controller.submitText(text, targetThreadId ?? threadId),
    interrupt: () => controller.interrupt(),
    reset: () => controller.reset(),
    returnToIdle: (turnRunId?: string | null) => controller.returnToIdle(turnRunId)
  };
}
