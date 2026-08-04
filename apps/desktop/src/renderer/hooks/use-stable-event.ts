import { useCallback, useRef } from "react";

type EventHandler = (...args: any[]) => any;

export function useStableEvent<T extends EventHandler>(handler: T): T {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  return useCallback(((...args: Parameters<T>) => handlerRef.current(...args)) as T, []);
}
