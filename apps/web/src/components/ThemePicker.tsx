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
    <label className="theme-picker">
      <span className="theme-swatch" aria-hidden="true" />
      <span className="sr-only">Colour theme</span>
      <select
        aria-label="Colour theme"
        value={theme}
        onChange={(event) => {
          const next = event.target.value as WorkspaceTheme;
          saveTheme(next);
          setTheme(next);
        }}
      >
        <option value="orbit">Orbit · Navy</option>
        <option value="beacon">Beacon · Amber</option>
      </select>
    </label>
  );
}
