import { describe, expect, it } from "vitest";
import { browserDesktop } from "./desktop.js";

describe("backend browser display", () => {
  it("explains an unavailable Linux desktop and never forwards backend credentials", () => {
    const desktop = browserDesktop(
      { VEKTOR_ACCESS_TOKEN: "private-token", VEKTOR_OPENROUTER_KEY: "provider-key" },
      "linux",
    );
    expect(desktop.capabilities.visibleWindowAvailable).toBe(false);
    expect(desktop.capabilities.reason).toContain("backend has no desktop display");
    expect(JSON.stringify(desktop)).not.toContain("private-token");
    expect(JSON.stringify(desktop)).not.toContain("provider-key");
  });
  it("passes only the display connection for X11 or Wayland", () => {
    const x11 = browserDesktop({ DISPLAY: ":42", VEKTOR_ACCESS_TOKEN: "private-token" }, "linux");
    expect(x11.capabilities.visibleWindowAvailable).toBe(true);
    expect(x11.env).toEqual({ DISPLAY: ":42" });
    const wayland = browserDesktop(
      { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/test" },
      "linux",
    );
    expect(wayland.capabilities.visibleWindowAvailable).toBe(true);
    expect(wayland.args).toContain("--ozone-platform=wayland");
    expect(
      browserDesktop({ WAYLAND_DISPLAY: "wayland-0" }, "linux").capabilities.visibleWindowAvailable,
    ).toBe(false);
  });
});
