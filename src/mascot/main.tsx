import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeLinksToBrowser } from "../lib/dom";
import { Mascot } from "./Mascot";
import "./mascot.css";

routeLinksToBrowser();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Mascot />
  </StrictMode>,
);
