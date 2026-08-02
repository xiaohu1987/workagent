export type LiveEditPreviewSession = {
  toolCallId: string;
  threadId: string;
  paths: string[];
};

export type QueuedLiveEditPreviewSession = LiveEditPreviewSession & {
  completed: boolean;
  pathIndex: number;
};

export class LiveEditPreviewQueue {
  #sessions: QueuedLiveEditPreviewSession[] = [];

  get current(): QueuedLiveEditPreviewSession | null {
    return this.#sessions[0] ?? null;
  }

  get size(): number {
    return this.#sessions.length;
  }

  start(session: LiveEditPreviewSession): QueuedLiveEditPreviewSession | null {
    if (session.paths.length === 0 || this.#sessions.some((item) => item.toolCallId === session.toolCallId)) {
      return this.current;
    }
    this.#sessions.push({ ...session, paths: [...session.paths], completed: false, pathIndex: 0 });
    return this.current;
  }

  complete(toolCallId: string): QueuedLiveEditPreviewSession | null {
    const session = this.#sessions.find((item) => item.toolCallId === toolCallId);
    if (!session) return null;
    session.completed = true;
    return session === this.current ? session : null;
  }

  acknowledge(toolCallId: string, path: string): QueuedLiveEditPreviewSession | null {
    const current = this.current;
    if (!current || current.toolCallId !== toolCallId || current.paths[current.pathIndex] !== path || !current.completed) {
      return current;
    }
    if (current.pathIndex + 1 < current.paths.length) {
      current.pathIndex += 1;
      return current;
    }
    this.#sessions.shift();
    return this.current;
  }

  clear(): void {
    this.#sessions = [];
  }
}
