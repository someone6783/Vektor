import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesktopRoot } from "./DesktopRoot";
import "./index.css";
import { applyTheme, readTheme } from "./lib/theme";

applyTheme(readTheme());

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <DesktopRoot />
  </StrictMode>,
);
