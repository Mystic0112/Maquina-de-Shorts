import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readStoredTheme } from "./colors";
import "./styles.css";
import "./settings.css";
import "./details.css";

applyTheme(readStoredTheme()); // before first paint: no light/dark flash

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
