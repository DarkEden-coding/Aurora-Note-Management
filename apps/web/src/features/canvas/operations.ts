// SyncOperation factory: every canvas mutation carries an operation ID, device ID, base revision, and client timestamp per the shared contract.
import type { CanvasObject, SyncOperation } from "@aurora/shared";

const DEVICE_ID_KEY = "aurora.deviceId";

function randomId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // Deterministic fallback (test runtimes without crypto.randomUUID).
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4";
    } else if (i === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

export function newId(): string {
  return randomId();
}

/** Stable device identity persisted in localStorage so operations attribute to one device. */
export function getDeviceId(): string {
  if (typeof localStorage === "undefined") return randomId();
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = randomId();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    return randomId();
  }
}

export function makeUpsertOperation(
  object: CanvasObject,
  noteId: string,
  deviceId: string,
): SyncOperation {
  return {
    id: randomId(),
    deviceId,
    noteId,
    objectId: object.id,
    baseRevision: object.revision,
    clientTimestamp: new Date().toISOString(),
    mutation: { type: "upsert", object },
  };
}

export function makeDeleteOperation(
  objectId: string,
  baseRevision: number,
  noteId: string,
  deviceId: string,
): SyncOperation {
  return {
    id: randomId(),
    deviceId,
    noteId,
    objectId,
    baseRevision,
    clientTimestamp: new Date().toISOString(),
    mutation: { type: "delete" },
  };
}
