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
  onCompletedVideoEnd?: () => void;
};

type CharacterStyle = CSSProperties & {
  "--character-accent": string;
  "--character-intensity": number;
};

type VideoSlot = {
  source: string | null;
};

const videoByPhase: Record<RealtimeSceneState["phase"], string> = {
  idle: idleVideo,
  thinking: thinkingVideo,
  generating: generatingVideo,
  executing: executingVideo,
  completed: completedVideo,
  interrupted: interruptedVideo,
  failed: failedVideo
};

export function RealtimeCharacterLayer({ scene, onCompletedVideoEnd }: Props) {
  const videoSource = videoByPhase[scene.phase];
  const [videoSlots, setVideoSlots] = useState<VideoSlot[]>(() => [
    { source: videoSource },
    { source: null }
  ]);
  const [activeSlot, setActiveSlot] = useState(0);
  const activeSlotRef = useRef(0);
  const videoSlotsRef = useRef(videoSlots);
  const pendingSwitchRef = useRef<{ slot: number; source: string; token: number } | null>(null);
  const requestedSourceRef = useRef(videoSource);
  const readySlotSourcesRef = useRef(new Map<number, string>());
  const videoElementsRef = useRef(new Map<number, HTMLVideoElement>());
  const activeVideoEndedRef = useRef(false);
  const switchTokenRef = useRef(0);

  videoSlotsRef.current = videoSlots;
  activeSlotRef.current = activeSlot;
  requestedSourceRef.current = videoSource;

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

  useEffect(() => {
    const currentActiveSource = videoSlotsRef.current[activeSlotRef.current]?.source;
    if (currentActiveSource === videoSource) {
      pendingSwitchRef.current = null;
      return;
    }

    const nextSlot = activeSlotRef.current === 0 ? 1 : 0;
    const pendingSwitch = {
      slot: nextSlot,
      source: videoSource,
      token: switchTokenRef.current + 1
    };
    switchTokenRef.current = pendingSwitch.token;
    pendingSwitchRef.current = pendingSwitch;
    const nextElement = videoElementsRef.current.get(nextSlot);
    if (videoSlotsRef.current[nextSlot]?.source !== videoSource || !nextElement || nextElement.readyState < 3) {
      readySlotSourcesRef.current.delete(nextSlot);
    } else {
      readySlotSourcesRef.current.set(nextSlot, videoSource);
    }
    setVideoSlots((current) => current.map((slot, index) => (
      index === nextSlot ? { source: videoSource } : slot
    )));
    activatePendingVideo(nextElement);
  }, [videoSource]);

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
    if (source === completedVideo && requestedSourceRef.current === source) {
      onCompletedVideoEnd?.();
      return;
    }

    if (requestedSourceRef.current !== source) {
      activatePendingVideo(videoElementsRef.current.get(
        activeSlotRef.current === 0 ? 1 : 0
      ));
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
