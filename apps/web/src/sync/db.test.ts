// Verifies that IndexedDB can persist every row needed for offline library navigation.
import { describe, expect, it } from "vitest";
import { AuroraDb } from "./db.js";

describe("offline database schema", () => {
  it("includes project and folder stores for offline library navigation", () => {
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
    expect(database.verno).toBe(2);
    database.close();
  });
});
