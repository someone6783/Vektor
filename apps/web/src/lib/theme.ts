export type WorkspaceTheme = "orbit" | "beacon";

export const THEME_STORAGE_KEY = "vektor.theme";

export function readTheme(): WorkspaceTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "beacon" ? "beacon" : "orbit";
  } catch {
    return "orbit";
  }
}

export function applyTheme(theme: WorkspaceTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: WorkspaceTheme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The selected appearance still applies when storage is unavailable.
  }
}
