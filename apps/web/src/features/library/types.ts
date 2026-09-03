// This module defines Aurora's library client types. They are re-exports of the
// shared transport contract (GET /api/library summaries) so the client and server
// response shapes can never drift.
export type {
  LibraryFolder,
  LibraryNote,
  LibraryProject,
  LibraryTree,
} from "@aurora/shared";

/** Notes the user opened recently, newest first, tracked in the local cache. */
export interface RecentNote {
  noteId: string;
  openedAt: number;
}
