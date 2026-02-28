import type { JournalApi } from "@journal-reader/types";

export type { JournalApi };

declare global {
  interface Window {
    journalApi: JournalApi;
  }
}
