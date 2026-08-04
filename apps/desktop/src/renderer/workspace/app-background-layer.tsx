import { memo, useEffect, useRef, useState } from "react";
import { getChatBackgroundTransform, type ChatBackgroundSettings } from "../chat-background";

type BackgroundImage = { id: string; url: string };

type Props = {
  images: BackgroundImage[];
  activeIndex: number;
  settings: ChatBackgroundSettings;
};

export const AppBackgroundLayer = memo(function AppBackgroundLayer({ images, activeIndex, settings }: Props) {
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
