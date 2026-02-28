import { describe, it } from "vitest";

describe.skip("electron e2e smoke", () => {
  it("opens a PDF, resolves a citation, and saves annotations", async () => {
    // Planned E2E steps:
    // 1) launch Electron app
    // 2) open fixture PDF
    // 3) click a citation token and assert popup content
    // 4) create highlight + text note + sticky note
    // 5) save to PDF and reopen to verify persistence
  });
});
