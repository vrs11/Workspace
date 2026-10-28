import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./shared/styles/app.css";
if (import.meta.env.VITE_DESKTOP_TEST === "true")
  await import("@wdio/tauri-plugin");
createRoot(document.getElementById("root")!).render(<App />);
