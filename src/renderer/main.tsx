import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
import { QuitDialog } from "./components/quit-dialog";
import { initDensity } from "./lib/density";
import "./index.css";

// Before first paint — otherwise the app renders at the default scale and
// visibly resizes once React mounts.
initDensity();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    {/* Outside the app's boundary: the window must stay closable even after
        the app tree has crashed. If the dialog itself fails it renders nothing,
        never acknowledges, and main falls back to the native box. */}
    <ErrorBoundary fallback={null}>
      <QuitDialog />
    </ErrorBoundary>
  </React.StrictMode>
);
