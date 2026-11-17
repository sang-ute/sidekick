import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeLinksToBrowser } from "../lib/dom";
import { Settings } from "./Settings";
import "./settings.css";

routeLinksToBrowser();
document.body.classList.add("loading");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
