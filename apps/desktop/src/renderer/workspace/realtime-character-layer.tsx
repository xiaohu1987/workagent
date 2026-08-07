import { useEffect, useRef, useState, type CSSProperties } from "react";
import idleVideo from "../assets/realtime-state-idle.mp4";
import thinkingVideo from "../assets/realtime-state-thinking.mp4";
import generatingVideo from "../assets/realtime-state-generating.mp4";
import executingVideo from "../assets/realtime-state-executing.mp4";
import completedVideo from "../assets/realtime-state-completed.mp4";
import interruptedVideo from "../assets/realtime-state-interrupted.mp4";
import failedVideo from "../assets/realtime-state-failed.mp4";
import type { RealtimeSceneState } from "../realtime-enhancement";

type Props = {
  scene: RealtimeSceneState;
  onTerminalVideoEnd?: () => void;
};

type CharacterStyle = CSSProperties & {
  "--character-accent": string;
  "--character-intensity": number;
};

type VideoSlot = {
  source: string | null;
};

type PlaybackMode = "idle" | "working" | "generating" | "completed" | "interrupted" | "failed";

const videoByMode: Record<Exclude<PlaybackMode, "working">, string> = {
  idle: idleVideo,
  generating: generatingVideo,
  completed: completedVideo,
  interrupted: interruptedVideo,
  failed: failedVideo
};

function getPlaybackMode(phase: RealtimeSceneState["phase"]): PlaybackMode {
  if (phase === "thinking" || phase === "executing") return "working";
  return phase;
}

function isWorkingSource(source: string | null): boolean {
  return source === thinkingVideo || source === executingVideo;
}

export function RealtimeCharacterLayer({ scene, onTerminalVideoEnd }: Props) {
  const playbackMode = getPlaybackMode(scene.phase);
  const initialSource = playbackMode === "working" ? thinkingVideo : videoByMode[playbackMode];
  const [videoSlots, setVideoSlots] = useState<VideoSlot[]>(() => [
    { source: initialSource },
    { source: null }
  ]);
  const [activeSlot, setActiveSlot] = useState(0);
  const activeSlotRef = useRef(0);
  const videoSlotsRef = useRef(videoSlots);
  const pendingSwitchRef = useRef<{ slot: number; source: string; token: number } | null>(null);
  const requestedSourceRef = useRef(initialSource);
  const desiredModeRef = useRef<PlaybackMode>(playbackMode);
  const sceneIdentityRef = useRef({ generation: scene.generation, turnRunId: scene.turnRunId });
  const readySlotSourcesRef = useRef(new Map<number, string>());
  const videoElementsRef = useRef(new Map<number, HTMLVideoElement>());
  const activeVideoEndedRef = useRef(false);
  const switchTokenRef = useRef(0);

  videoSlotsRef.current = videoSlots;
  activeSlotRef.current = activeSlot;

  const activatePendingVideo = (element?: HTMLVideoElement) => {
    const pendingSwitch = pendingSwitchRef.current;
    if (!pendingSwitch || !activeVideoEndedRef.current) return;
    if (requestedSourceRef.current !== pendingSwitch.source) return;
    if (readySlotSourcesRef.current.get(pendingSwitch.slot) !== pendingSwitch.source) return;

    pendingSwitchRef.current = null;
    activeVideoEndedRef.current = false;
    if (element) void element.play().catch(() => undefined);
    setActiveSlot(pendingSwitch.slot);
  };

  const requestVideoSource = (source: string) => {
    const currentActiveSource = videoSlotsRef.current[activeSlotRef.current]?.source;
    requestedSourceRef.current = source;
    if (currentActiveSource === source) {
      pendingSwitchRef.current = null;
      return;
    }

    const nextSlot = activeSlotRef.current === 0 ? 1 : 0;
    const pendingSwitch = {
      slot: nextSlot,
      source,
      token: switchTokenRef.current + 1
    };
    switchTokenRef.current = pendingSwitch.token;
    pendingSwitchRef.current = pendingSwitch;
    const nextElement = videoElementsRef.current.get(nextSlot);
    if (videoSlotsRef.current[nextSlot]?.source !== source || !nextElement || nextElement.readyState < 3) {
      readySlotSourcesRef.current.delete(nextSlot);
    } else {
      readySlotSourcesRef.current.set(nextSlot, source);
    }
    setVideoSlots((current) => current.map((slot, index) => (
      index === nextSlot ? { source } : slot
    )));
    activatePendingVideo(nextElement);
  };

  const requestPlaybackMode = (mode: PlaybackMode, restartWorking = false) => {
    desiredModeRef.current = mode;
    const currentActiveSource = videoSlotsRef.current[activeSlotRef.current]?.source ?? null;

    if (mode === "working") {
      const shouldStartWithThinking = restartWorking || !isWorkingSource(currentActiveSource);
      if (!shouldStartWithThinking) {
        // Tool events can change thinking/executing metadata without changing
        // the task-level working video sequence.
        pendingSwitchRef.current = null;
        requestedSourceRef.current = currentActiveSource as string;
        return;
      }
      requestVideoSource(thinkingVideo);
      return;
    }

    requestVideoSource(videoByMode[mode]);
  };

  useEffect(() => {
    const identityChanged = sceneIdentityRef.current.generation !== scene.generation ||
      sceneIdentityRef.current.turnRunId !== scene.turnRunId;
    if (identityChanged) {
      sceneIdentityRef.current = { generation: scene.generation, turnRunId: scene.turnRunId };
    }

    requestPlaybackMode(playbackMode, identityChanged && playbackMode === "working");
  }, [scene.generation, scene.phase, scene.turnRunId, playbackMode]);

  const handleVideoCanPlay = (slot: number, source: string, element: HTMLVideoElement) => {
    readySlotSourcesRef.current.set(slot, source);
    if (activeSlotRef.current === slot) {
      void element.play().catch(() => undefined);
      return;
    }
    activatePendingVideo(element);
  };

  const handleVideoEnded = (slot: number, source: string, element: HTMLVideoElement) => {
    if (slot !== activeSlotRef.current || videoSlotsRef.current[slot]?.source !== source) return;

    activeVideoEndedRef.current = true;
    const mode = desiredModeRef.current;

    if (mode === "working") {
      const nextSource = source === thinkingVideo ? executingVideo : thinkingVideo;
      requestVideoSource(nextSource);
      activatePendingVideo(videoElementsRef.current.get(
        activeSlotRef.current === 0 ? 1 : 0
      ));
      return;
    }

    if (
      (mode === "completed" || mode === "failed" || mode === "interrupted") &&
      source === videoByMode[mode] &&
      requestedSourceRef.current === source
    ) {
      onTerminalVideoEnd?.();
      return;
    }

    if (requestedSourceRef.current !== source) {
      activatePendingVideo(videoElementsRef.current.get(
        activeSlotRef.current === 0 ? 1 : 0
      ));
      return;
    }

    if (mode === "idle" || mode === "generating") {
      activeVideoEndedRef.current = false;
      element.currentTime = 0;
      void element.play().catch(() => undefined);
      return;
    }

    activeVideoEndedRef.current = false;
    element.currentTime = 0;
    void element.play().catch(() => undefined);
  };

  const handleVideoTransitionEnd = (slot: number, event: React.TransitionEvent<HTMLVideoElement>) => {
    if (event.propertyName !== "opacity" || slot === activeSlotRef.current) return;
    event.currentTarget.pause();
  };

  const style: CharacterStyle = {
    "--character-accent": scene.reaction.accent,
    "--character-intensity": Math.max(0.24, scene.reaction.intensity)
  };

  return (
    <div
      className="realtime-character-layer"
      data-phase={scene.phase}
      data-mood={scene.reaction.mood}
      data-pulse={scene.reaction.pulse ? "true" : "false"}
      style={style}
      aria-hidden="true"
    >
      <div className="realtime-character-frame" />
      <div className="realtime-human-video-stack">
        {videoSlots.map((slot, index) => slot.source ? (
          <video
            key={`${index}-${slot.source}`}
            className={`realtime-human-video ${activeSlot === index ? "is-active" : "is-preparing"}`}
            src={slot.source}
            autoPlay={activeSlot === index}
            muted
            playsInline
            preload="auto"
            loop={false}
            ref={(element) => {
              if (element) videoElementsRef.current.set(index, element);
              else videoElementsRef.current.delete(index);
            }}
            onCanPlay={(event) => handleVideoCanPlay(index, slot.source as string, event.currentTarget)}
            onTransitionEnd={(event) => handleVideoTransitionEnd(index, event)}
            onEnded={(event) => handleVideoEnded(index, slot.source as string, event.currentTarget)}
            aria-hidden="true"
          />
        ) : null)}
      </div>
      <div className="realtime-character-scan" />
    </div>
  );
}
