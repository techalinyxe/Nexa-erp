import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Le service worker met l'interface en cache pour le mode hors ligne (PWA).
// Dans Tauri, les fichiers sont déjà embarqués dans l'application.
if (!("__TAURI_INTERNALS__" in window)) {
  void import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true }));
}
