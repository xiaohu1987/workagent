import { memo, useEffect, useRef, useState } from "react";
import { getChatBackgroundBlurFilter, getChatBackgroundTransform, type ChatBackgroundSettings } from "../chat-background";

type BackgroundImage = { id: string; url: string };

type Props = {
  images: BackgroundImage[];
  videos: BackgroundImage[];
  activeIndex: number;
  activeVideoIndex: number;
  settings: ChatBackgroundSettings;
  onVideoEnded: () => void;
};

export const AppBackgroundLayer = memo(function AppBackgroundLayer({ images, videos, activeIndex, activeVideoIndex, settings, onVideoEnded }: Props) {
  const lastActiveIndexRef = useRef(activeIndex);
  const [retainedPreviousIndex, setRetainedPreviousIndex] = useState<number | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const previousIndexForRender = lastActiveIndexRef.current !== activeIndex
    ? lastActiveIndexRef.current
    : retainedPreviousIndex;
  const visibleIndexes = previousIndexForRender === null || previousIndexForRender === activeIndex
    ? [activeIndex]
    : [previousIndexForRender, activeIndex];

  useEffect(() => {
    if (lastActiveIndexRef.current === activeIndex) return;
    setRetainedPreviousIndex(lastActiveIndexRef.current);
    lastActiveIndexRef.current = activeIndex;
    const timer = window.setTimeout(() => setRetainedPreviousIndex(null), 650);
    return () => window.clearTimeout(timer);
  }, [activeIndex]);

  useEffect(() => {
    const nextIndex = images.length > 1 ? (activeIndex + 1) % images.length : activeIndex;
    const nextImage = images[nextIndex];
    if (!nextImage || nextIndex === activeIndex) return;
    const preload = new Image();
    preload.decoding = "async";
    preload.src = nextImage.url;
    void preload.decode().catch(() => undefined);
  }, [activeIndex, images]);

  useEffect(() => {
    const handleVisibilityChange = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const showCustomVideo = settings.mode === "dynamic" && settings.dynamicSource === "custom" && videos.length > 0;
  const activeVideo = videos[activeVideoIndex] ?? null;
  const videoPlaybackTimeRef = useRef(0);
  const [videoTransition, setVideoTransition] = useState<{
    active: BackgroundImage | null;
    outgoing: BackgroundImage | null;
    outgoingTime: number;
  }>(() => ({
    active: activeVideo,
    outgoing: null,
    outgoingTime: 0
  }));

  if (videoTransition.active?.id !== activeVideo?.id) {
    setVideoTransition({
      active: activeVideo,
      outgoing: videoTransition.active,
      outgoingTime: videoPlaybackTimeRef.current
    });
    videoPlaybackTimeRef.current = 0;
  }

  useEffect(() => {
    if (!videoTransition.outgoing) return;
    const activeId = videoTransition.active?.id;
    const timer = window.setTimeout(() => {
      setVideoTransition((current) => current.active?.id === activeId
        ? { ...current, outgoing: null }
        : current);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [videoTransition.active?.id, videoTransition.outgoing?.id]);

  if (showCustomVideo && activeVideo) {
    const opacity = settings.opacity / 100;
    const videoStyle = { objectFit: settings.fit, objectPosition: "center", opacity } as const;
    return (
      <div className="app-background-layer" aria-hidden="true">
        <div className="app-background-motion is-active">
          <div className="app-background-parallax app-background-video-stack">
            {videoTransition.outgoing ? (
              <div
                key={videoTransition.outgoing.id}
                className="app-background-video-layer is-leaving"
                aria-hidden="true"
              >
                <video
                  className="app-background-video"
                  src={videoTransition.outgoing.url}
                  muted
                  playsInline
                  preload="auto"
                  onLoadedMetadata={(event) => {
                    if (videoTransition.outgoingTime > 0 && Number.isFinite(event.currentTarget.duration)) {
                      event.currentTarget.currentTime = Math.min(videoTransition.outgoingTime, event.currentTarget.duration);
                    }
                  }}
                  style={{ ...videoStyle, filter: getChatBackgroundBlurFilter(settings.videoBlur) }}
                />
              </div>
            ) : null}
            <div
              key={activeVideo.id}
              className={`app-background-video-layer ${videoTransition.outgoing ? "is-entering" : ""}`}
            >
              <video
                className="app-background-video"
                src={activeVideo.url}
                autoPlay
                muted
                loop={videos.length === 1 || !settings.videoRotationEnabled}
                playsInline
                preload="auto"
                onEnded={onVideoEnded}
                onTimeUpdate={(event) => { videoPlaybackTimeRef.current = event.currentTarget.currentTime; }}
                onLoadedMetadata={(event) => { void event.currentTarget.play().catch(() => undefined); }}
                style={{ ...videoStyle, filter: getChatBackgroundBlurFilter(settings.videoBlur) }}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-background-layer" aria-hidden="true">
      {visibleIndexes.map((index) => {
        const image = images[index];
        if (!image) return null;
        const isActive = index === activeIndex;
        const opacity = isActive ? settings.opacity / 100 : 0;
        const imageStyle = { objectFit: settings.fit, objectPosition: "center", transform: getChatBackgroundTransform(settings) };
        return (
          <div key={image.id} className={`app-background-motion ${isActive ? "is-active" : ""} ${isActive && documentVisible && settings.motionEnabled ? "is-enabled" : ""}`}>
            {settings.depthEnabled ? <div className="app-background-depth-backdrop"><img src={image.url} alt="" decoding="async" style={{ ...imageStyle, filter: `blur(${settings.blur + 8}px) saturate(0.86)`, opacity: opacity * 0.34 }} /></div> : null}
            <div className="app-background-parallax"><img src={image.url} alt="" decoding="async" style={{ ...imageStyle, filter: `blur(${settings.blur}px)`, opacity }} /></div>
            {settings.depthEnabled ? <div className="app-background-depth-foreground"><img src={image.url} alt="" decoding="async" style={{ ...imageStyle, filter: `blur(${Math.max(0, settings.blur - 2)}px) saturate(1.08)`, opacity: opacity * 0.24 }} /></div> : null}
            {settings.atmosphereEnabled && isActive ? <div className="app-background-atmosphere" /> : null}
          </div>
        );
      })}
    </div>
  );
});
