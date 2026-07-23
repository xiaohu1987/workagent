import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  DEFAULT_CHAT_BACKGROUND_SURFACES,
  getChatBackgroundSurfaceStyleVars,
  getChatBackgroundTransform,
  normalizeChatBackgroundSettings,
  normalizeChatBackgroundSurfaces,
  readChatBackgroundSettings,
  writeChatBackgroundSettings
} from "../apps/desktop/src/renderer/chat-background";

describe("chat background settings", () => {
  it("normalizes invalid and out-of-range values", () => {
    expect(normalizeChatBackgroundSettings({
      enabled: false,
      opacity: 145,
      blur: -8,
      fit: "unexpected",
      zoom: 240,
      positionX: -30,
      positionY: 180,
      fileName: "  scene.jpg  ",
      surfaces: {
        windowbar: 200,
        sidebar: -12,
        workspace: "bad",
        rightPanel: 55.6,
        terminal: 8,
        dialog: null
      }
    })).toEqual({
      enabled: false,
      opacity: 100,
      blur: 0,
      fit: "cover",
      zoom: 180,
      positionX: 0,
      positionY: 100,
      fileName: "scene.jpg",
      surfaces: {
        windowbar: 100,
        sidebar: 0,
        workspace: DEFAULT_CHAT_BACKGROUND_SURFACES.workspace,
        rightPanel: 56,
        terminal: 8,
        dialog: DEFAULT_CHAT_BACKGROUND_SURFACES.dialog
      }
    });
  });

  it("fills missing surface opacities with defaults", () => {
    expect(normalizeChatBackgroundSurfaces({ sidebar: 18 })).toEqual({
      ...DEFAULT_CHAT_BACKGROUND_SURFACES,
      sidebar: 18
    });
  });

  it("falls back when persisted JSON is malformed", () => {
    const storage = { getItem: () => "not-json" };
    expect(readChatBackgroundSettings(storage)).toEqual(DEFAULT_CHAT_BACKGROUND_SETTINGS);
  });

  it("writes normalized settings", () => {
    let persisted = "";
    writeChatBackgroundSettings(
      {
        enabled: true,
        opacity: 32.4,
        blur: 12.7,
        fit: "contain",
        zoom: 125.4,
        positionX: 24.4,
        positionY: 75.6,
        fileName: "wallpaper.png",
        surfaces: {
          ...DEFAULT_CHAT_BACKGROUND_SURFACES,
          sidebar: 28.4,
          workspace: 12.2
        }
      },
      { setItem: (_key, value) => { persisted = value; } }
    );
    expect(JSON.parse(persisted)).toEqual({
      enabled: true,
      opacity: 32,
      blur: 13,
      fit: "contain",
      zoom: 125,
      positionX: 24,
      positionY: 76,
      fileName: "wallpaper.png",
      surfaces: {
        ...DEFAULT_CHAT_BACKGROUND_SURFACES,
        sidebar: 28,
        workspace: 12
      }
    });
  });

  it("turns drag positions into a visible pan transform", () => {
    expect(getChatBackgroundTransform({
      ...DEFAULT_CHAT_BACKGROUND_SETTINGS,
      zoom: 120,
      positionX: 0,
      positionY: 100
    })).toBe("translate3d(10%, -10%, 0) scale(1.2)");
  });

  it("exposes surface opacities as css custom properties", () => {
    expect(getChatBackgroundSurfaceStyleVars({
      ...DEFAULT_CHAT_BACKGROUND_SURFACES,
      sidebar: 40,
      workspace: 15
    })).toEqual({
      "--app-bg-windowbar": "0.62",
      "--app-bg-sidebar": "0.4",
      "--app-bg-workspace": "0.15",
      "--app-bg-right-panel": "0.22",
      "--app-bg-terminal": "0.4",
      "--app-bg-dialog": "0.62"
    });
  });
});
