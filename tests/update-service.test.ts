import { describe, expect, it } from "vitest";
import { isVersionGreater } from "../apps/desktop/src/main/update-service";

describe("update version comparison", () => {
  it("recognizes a newer semantic version", () => {
    expect(isVersionGreater("1.1.3", "1.0.0")).toBe(true);
    expect(isVersionGreater("1.0.1", "1.0.0")).toBe(true);
  });

  it("does not offer equal or older versions", () => {
    expect(isVersionGreater("1.0.0", "1.0.0")).toBe(false);
    expect(isVersionGreater("0.9.9", "1.0.0")).toBe(false);
  });

  it("handles prerelease versions without treating them as newer than a stable release", () => {
    expect(isVersionGreater("1.1.0-beta.1", "1.1.0")).toBe(false);
    expect(isVersionGreater("1.1.0", "1.1.0-beta.1")).toBe(true);
  });
});
