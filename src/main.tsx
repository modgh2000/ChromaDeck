import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";
import IdentifyOverlay from "./components/IdentifyOverlay";
import { I18nProvider } from "./lib/i18n";
import { setTrayLanguage } from "./lib/tauri";

const label = isTauri() ? getCurrentWindow().label : "main";
if (label.startsWith("identify-")) {
  // — Identify overlay window —————————————————————————————————————
  // The overlay window must be see-through: index.html ships an inline cream
  // background on <body> and App.css paints html/body with --color-background,
  // so both have to be cleared at runtime.
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  const n = parseInt(label.replace("identify-", ""), 10);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider>
        <IdentifyOverlay number={n} />
      </I18nProvider>
    </React.StrictMode>,
  );
} else {
  // — Main application window —————————————————————————————————————
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider onLocaleChange={(loc) => void setTrayLanguage(loc)}>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
}
