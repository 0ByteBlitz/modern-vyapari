import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/error-boundary";
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
  </React.StrictMode>
);
