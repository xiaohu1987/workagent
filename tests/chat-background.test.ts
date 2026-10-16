import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_BACKGROUND_SETTINGS,
  DEFAULT_CHAT_BACKGROUND_SURFACES,
  getChatBackgroundActiveIndex,
  getChatBackgroundBlurFilter,
  getChatBackgroundRandomNextIndex,
  getChatBackgroundVideoMimeType,
  getChatBackgroundSurfaceStyleVars,
  getChatBackgroundTransform,
  isChatBackgroundRotationActive,
  normalizeChatBackgroundSettings,
  normalizeChatBackgroundSurfaces,
  readChatBackgroundSettings,
  writeChatBackgroundSettings
} from "../apps/desktop/src/renderer/chat-background";

const rendererHtml = readFileSync(new URL("../apps/desktop/src/renderer/index.html", import.meta.url), "utf8");

describe("chat background settings", () => {
  it("allows blob-backed video backgrounds in the renderer CSP", () => {
    expect(rendererHtml).toMatch(/media-src[^;]*\bblob:/);
  });

  it("recognizes WebM and MP4 background videos from MIME type or extension", () => {
    expect(getChatBackgroundVideoMimeType({ name: "scene.webm", type: "" })).toBe("video/webm");
    expect(getChatBackgroundVideoMimeType({ name: "scene.MP4", type: "application/octet-stream" })).toBe("video/mp4");
    expect(getChatBackgroundVideoMimeType({ name: "scene", type: "video/mp4" })).toBe("video/mp4");
    expect(getChatBackgroundVideoMimeType({ name: "scene.mov", type: "video/quicktime" })).toBeNull();
  });

  it("normalizes invalid and out-of-range values", () => {
    expect(normalizeChatBackgroundSettings({
      enabled: false,
      rotationEnabled: true,
      rotationIntervalSeconds: 4,
      motionEnabled: false,
      parallaxEnabled: false,
      depthEnabled: false,
      atmosphereEnabled: false,
      opacity: 145,
      blur: -8,
      videoBlur: 48,
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
      mode: "none",
      enabled: false,
      rotationEnabled: true,
      rotationIntervalSeconds: 10,
      motionEnabled: false,
      parallaxEnabled: false,
      depthEnabled: false,
      atmosphereEnabled: false,
      opacity: 100,
      blur: 0,
      videoBlur: 30,
      fit: "cover",
      zoom: 180,
      positionX: 0,
      positionY: 100,
      fileName: "scene.jpg",
      dynamicSource: "preset",
      videoFileName: null,
      videoRotationEnabled: false,
      videoRotationOrder: "sequential",
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

  it("defaults custom video blur to zero and clamps its range", () => {
    expect(DEFAULT_CHAT_BACKGROUND_SETTINGS.videoBlur).toBe(0);
    expect(normalizeChatBackgroundSettings({}).videoBlur).toBe(0);
    expect(normalizeChatBackgroundSettings({ videoBlur: -4 }).videoBlur).toBe(0);
    expect(normalizeChatBackgroundSettings({ videoBlur: 12.6 }).videoBlur).toBe(13);
    expect(normalizeChatBackgroundSettings({ videoBlur: 40 }).videoBlur).toBe(30);
    expect(normalizeChatBackgroundSettings({ videoBlur: "bad" }).videoBlur).toBe(0);
  });

  it("removes the video blur filter at zero", () => {
    expect(getChatBackgroundBlurFilter(0)).toBe("none");
    expect(getChatBackgroundBlurFilter(-1)).toBe("none");
    expect(getChatBackgroundBlurFilter(6)).toBe("blur(6px)");
  });

  it("never repeats the current video in random rotation", () => {
    for (let currentIndex = 0; currentIndex < 4; currentIndex += 1) {
      expect(getChatBackgroundRandomNextIndex(currentIndex, 4, () => 0)).not.toBe(currentIndex);
      expect(getChatBackgroundRandomNextIndex(currentIndex, 4, () => 0.999999)).not.toBe(currentIndex);
    }
    expect(getChatBackgroundRandomNextIndex(1, 2, () => 0)).toBe(0);
    expect(getChatBackgroundRandomNextIndex(0, 2, () => 1)).toBe(1);
    expect(getChatBackgroundRandomNextIndex(0, 1, () => 0)).toBe(0);
  });

  it("enables the lightweight motion effects for existing background settings", () => {
    expect(normalizeChatBackgroundSettings({ enabled: true })).toMatchObject({
      motionEnabled: true,
      parallaxEnabled: true,
      depthEnabled: true,
      atmosphereEnabled: true
    });
  });

  it("defaults to no background mode and migrates legacy image settings", () => {
    expect(DEFAULT_CHAT_BACKGROUND_SETTINGS.mode).toBe("none");
    expect(normalizeChatBackgroundSettings({ enabled: true })).toMatchObject({ mode: "none" });
    expect(normalizeChatBackgroundSettings({ enabled: true, fileName: "scene.jpg" })).toMatchObject({ mode: "image" });
    expect(normalizeChatBackgroundSettings({ mode: "dynamic", enabled: false })).toMatchObject({ mode: "dynamic" });
  });

  it("falls back when persisted JSON is malformed", () => {
    const storage = { getItem: () => "not-json" };
    expect(readChatBackgroundSettings(storage)).toEqual(DEFAULT_CHAT_BACKGROUND_SETTINGS);
  });

  it("writes normalized settings", () => {
    let persisted = "";
    writeChatBackgroundSettings(
      {
        mode: "image",
        enabled: true,
        rotationEnabled: true,
        rotationIntervalSeconds: 72.4,
        motionEnabled: true,
        parallaxEnabled: false,
        depthEnabled: true,
        atmosphereEnabled: false,
        opacity: 32.4,
        blur: 12.7,
        videoBlur: 5.2,
        fit: "contain",
        zoom: 125.4,
        positionX: 24.4,
        positionY: 75.6,
        fileName: "wallpaper.png",
        dynamicSource: "preset",
        videoFileName: null,
        videoRotationEnabled: false,
        videoRotationOrder: "sequential",
        surfaces: {
          ...DEFAULT_CHAT_BACKGROUND_SURFACES,
          sidebar: 28.4,
          workspace: 12.2
        }
      },
      { setItem: (_key, value) => { persisted = value; } }
    );
    expect(JSON.parse(persisted)).toEqual({
      mode: "image",
      enabled: true,
      rotationEnabled: true,
      rotationIntervalSeconds: 72,
      motionEnabled: true,
      parallaxEnabled: false,
      depthEnabled: true,
      atmosphereEnabled: false,
      opacity: 32,
      blur: 13,
      videoBlur: 5,
      fit: "contain",
      zoom: 125,
      positionX: 24,
      positionY: 76,
      fileName: "wallpaper.png",
      dynamicSource: "preset",
      videoFileName: null,
      videoRotationEnabled: false,
      videoRotationOrder: "sequential",
      surfaces: {
        ...DEFAULT_CHAT_BACKGROUND_SURFACES,
        sidebar: 28,
        workspace: 12
      }
    });
  });

  it("persists and restores the selected background mode", () => {
    let persisted = "";
    writeChatBackgroundSettings(
      { ...DEFAULT_CHAT_BACKGROUND_SETTINGS, mode: "dynamic" },
      { setItem: (_key, value) => { persisted = value; } }
    );

    expect(readChatBackgroundSettings({ getItem: () => persisted }).mode).toBe("dynamic");
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

  it("only rotates an enabled background collection with multiple images", () => {
    expect(isChatBackgroundRotationActive({
      ...DEFAULT_CHAT_BACKGROUND_SETTINGS,
      enabled: true,
      rotationEnabled: true
    }, 1)).toBe(false);
    expect(isChatBackgroundRotationActive({
      ...DEFAULT_CHAT_BACKGROUND_SETTINGS,
      enabled: true,
      rotationEnabled: true
    }, 2)).toBe(true);
  });

  it("restores the manually selected background image", () => {
    expect(getChatBackgroundActiveIndex(
      { fileName: "second.png" },
      [{ fileName: "first.png" }, { fileName: "second.png" }]
    )).toBe(1);
    expect(getChatBackgroundActiveIndex(
      { fileName: "missing.png" },
      [{ fileName: "first.png" }, { fileName: "second.png" }]
    )).toBe(0);
  });
});
