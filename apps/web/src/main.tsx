import "@fontsource-variable/inter";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { RouterProvider } from "./router";
import { SessionProvider } from "./session";
import { initTheme } from "./shell";
import { ToastProvider } from "./ui";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider>
      <ToastProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastProvider>
    </RouterProvider>
  </StrictMode>,
);
