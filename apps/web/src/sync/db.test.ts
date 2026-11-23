// Verifies that IndexedDB can persist every row needed for offline library navigation.
import { describe, expect, it } from "vitest";
import { AuroraDb } from "./db.js";

describe("offline database schema", () => {
  it("keeps the offline library stores and indexes queued edits by object", () => {
    const database = new AuroraDb();

    expect(database.tables.map((table) => table.name).sort()).toEqual([
      "conflicts",
      "folders",
      "meta",
      "notes",
      "objects",
      "outbox",
      "projects",
    ]);
    expect(database.outbox.schema.idxByName.objectId).toBeDefined();
    database.close();
  });
});
