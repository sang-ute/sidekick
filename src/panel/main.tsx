import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeLinksToBrowser } from "../lib/dom";
import { Panel } from "./Panel";
import "./panel.css";

routeLinksToBrowser();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
