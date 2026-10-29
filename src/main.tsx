import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { useStore } from "./state/store";
import "./styles.css";

async function start() {
  // Development only: `/?mock` in a plain browser uses generated sample data.
  const params = new URLSearchParams(location.search);
  if (import.meta.env.DEV && params.has("mock")) {
    (await import("./dev/mockBackend")).installMockBackend();
    const view = params.get("view");
    if (view === "network" || view === "planet") useStore.getState().setViewMode(view);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
