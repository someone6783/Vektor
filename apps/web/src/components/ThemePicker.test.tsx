import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemePicker } from "./ThemePicker";
import { THEME_STORAGE_KEY } from "../lib/theme";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("workspace appearance", () => {
  it("restores a saved theme and persists the next selection", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "beacon");
    render(<ThemePicker />);
    expect(screen.getByLabelText("Colour theme")).toHaveTextContent("Beacon · Amber");
    expect(document.documentElement).toHaveAttribute("data-theme", "beacon");
    fireEvent.click(screen.getByLabelText("Colour theme"));
    fireEvent.click(screen.getByRole("option", { name: "Orbit · Navy" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("orbit");
    expect(document.documentElement).toHaveAttribute("data-theme", "orbit");
  });

  it("defaults to Orbit for an invalid stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "unknown");
    render(<ThemePicker />);
    expect(document.documentElement).toHaveAttribute("data-theme", "orbit");
  });

  it("can change appearance when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    render(<ThemePicker />);
    fireEvent.click(screen.getByLabelText("Colour theme"));
    fireEvent.click(screen.getByRole("option", { name: "Beacon · Amber" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "beacon");
  });
});
