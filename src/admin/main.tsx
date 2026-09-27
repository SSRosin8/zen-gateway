import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LanGate } from "./components/LanAccess.tsx";
import "./styles/index.css";

const host = document.getElementById("root");
if (!host) throw new Error("找不到 #root 挂载点");

createRoot(host).render(
  <StrictMode>
    {/* 局域网访客未登录时先看到登录页；App 的轮询要等登录后才开始。 */}
    <LanGate>
      <App />
    </LanGate>
  </StrictMode>,
);
