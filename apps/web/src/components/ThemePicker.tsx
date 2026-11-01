import { ChoicePicker } from "./ChoicePicker";
import { useEffect, useState } from "react";
import { applyTheme, readTheme, saveTheme, type WorkspaceTheme } from "../lib/theme";

export function ThemePicker() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <ChoicePicker
      label="Colour theme"
      value={theme}
      options={[
        { value: "orbit", label: "Orbit · Navy" },
        { value: "beacon", label: "Beacon · Amber" },
      ]}
      className="theme-picker"
      prefix={<span className="theme-swatch" aria-hidden="true" />}
      onChange={(value) => {
        const next = value as WorkspaceTheme;
        saveTheme(next);
        setTheme(next);
      }}
    />
  );
}
