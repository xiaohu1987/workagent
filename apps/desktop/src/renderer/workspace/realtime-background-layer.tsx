import type { CSSProperties } from "react";
import type { RealtimeSceneState } from "../realtime-enhancement";

type Props = {
  scene: RealtimeSceneState;
};

type RealtimeLayerStyle = CSSProperties & {
  "--realtime-accent": string;
  "--realtime-intensity": number;
};

export function RealtimeBackgroundLayer({ scene }: Props) {
  const style: RealtimeLayerStyle = {
    "--realtime-accent": scene.reaction.accent,
    "--realtime-intensity": scene.reaction.intensity
  };

  return (
    <div
      className="realtime-enhancement-layer"
      data-phase={scene.phase}
      data-mood={scene.reaction.mood}
      data-pulse={scene.reaction.pulse ? "true" : "false"}
      style={style}
      aria-hidden="true"
    />
  );
}

