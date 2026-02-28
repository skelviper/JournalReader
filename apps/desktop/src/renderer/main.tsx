import React from "react";
import { createRoot } from "react-dom/client";
import { ReaderApp } from "@journal-reader/ui";

const rootNode = document.getElementById("root");
if (!rootNode) {
  throw new Error("Missing root element");
}

createRoot(rootNode).render(
  <React.StrictMode>
    <ReaderApp api={window.journalApi} />
  </React.StrictMode>,
);
