import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  getChatBackgroundTransform,
  normalizeChatBackgroundSettings,
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
      fileName: "  scene.jpg  "
    })).toEqual({
      enabled: false,
      opacity: 100,
      blur: 0,
      fit: "cover",
      zoom: 180,
      positionX: 0,
      positionY: 100,
      fileName: "scene.jpg"
    });
  });

  it("falls back when persisted JSON is malformed", () => {
    const storage = { getItem: () => "not-json" };
    expect(readChatBackgroundSettings(storage)).toEqual(DEFAULT_CHAT_BACKGROUND_SETTINGS);
  });

  it("writes normalized settings", () => {
    let persisted = "";
    writeChatBackgroundSettings(
      { enabled: true, opacity: 32.4, blur: 12.7, fit: "contain", zoom: 125.4, positionX: 24.4, positionY: 75.6, fileName: "wallpaper.png" },
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
      fileName: "wallpaper.png"
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
});
