import { getChatBackgroundTransform, type ChatBackgroundSettings } from "../chat-background";

type BackgroundImage = { id: string; url: string };

type Props = {
  images: BackgroundImage[];
  activeIndex: number;
  settings: ChatBackgroundSettings;
};

export function AppBackgroundLayer({ images, activeIndex, settings }: Props) {
  return (
    <div className="app-background-layer" aria-hidden="true">
      {images.map((image, index) => {
        const isActive = index === activeIndex;
        const opacity = isActive ? settings.opacity / 100 : 0;
        const imageStyle = { objectFit: settings.fit, objectPosition: "center", transform: getChatBackgroundTransform(settings) };
        return (
          <div key={image.id} className={`app-background-motion ${isActive ? "is-active" : ""} ${settings.motionEnabled ? "is-enabled" : ""}`}>
            {settings.depthEnabled ? <div className="app-background-depth-backdrop"><img src={image.url} alt="" style={{ ...imageStyle, filter: `blur(${settings.blur + 8}px) saturate(0.86)`, opacity: opacity * 0.34 }} /></div> : null}
            <div className="app-background-parallax"><img src={image.url} alt="" style={{ ...imageStyle, filter: `blur(${settings.blur}px)`, opacity }} /></div>
            {settings.depthEnabled ? <div className="app-background-depth-foreground"><img src={image.url} alt="" style={{ ...imageStyle, filter: `blur(${Math.max(0, settings.blur - 2)}px) saturate(1.08)`, opacity: opacity * 0.24 }} /></div> : null}
            {settings.atmosphereEnabled && isActive ? <div className="app-background-atmosphere" /> : null}
          </div>
        );
      })}
    </div>
  );
}
