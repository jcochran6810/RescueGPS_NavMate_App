import { describe, expect, it } from "vitest";
import { installPlatform } from "./install";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

describe("installPlatform", () => {
  it("shows nothing once running installed", () => {
    expect(
      installPlatform({
        userAgent: ANDROID_CHROME,
        standalone: true,
        hasPrompt: true,
      }),
    ).toBe("installed");
  });
  it("offers the one-tap install when the browser gave us a prompt", () => {
    expect(
      installPlatform({
        userAgent: ANDROID_CHROME,
        standalone: false,
        hasPrompt: true,
      }),
    ).toBe("prompt");
  });
  it("gives Share → Add to Home Screen steps on iPhone Safari", () => {
    expect(
      installPlatform({
        userAgent: IPHONE_SAFARI,
        standalone: false,
        hasPrompt: false,
      }),
    ).toBe("ios");
  });
  it("sends other iOS browsers to Safari", () => {
    expect(
      installPlatform({
        userAgent: IPHONE_CHROME,
        standalone: false,
        hasPrompt: false,
      }),
    ).toBe("ios-other");
  });
  it("recognises an iPad pretending to be a Mac by its touch points", () => {
    expect(
      installPlatform({
        userAgent: IPAD_DESKTOP_UA,
        standalone: false,
        hasPrompt: false,
        maxTouchPoints: 5,
      }),
    ).toBe("ios");
    expect(
      installPlatform({
        userAgent: IPAD_DESKTOP_UA,
        standalone: false,
        hasPrompt: false,
        maxTouchPoints: 0,
      }),
    ).toBe("manual");
  });
  it("falls back to the browser menu when Android has not offered a prompt yet", () => {
    expect(
      installPlatform({
        userAgent: ANDROID_CHROME,
        standalone: false,
        hasPrompt: false,
      }),
    ).toBe("manual");
  });
});
