import type { CanvasObject } from "@aurora/shared";

// PostgreSQL JSONB can reorder keys, so transport order is not document identity.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function contentKey(object: CanvasObject): string {
  return JSON.stringify(
    canonical([
      object.bounds,
      object.payload,
      object.rotation,
      object.zIndex,
      object.locked,
      object.groupId,
      object.pageId,
      object.kind,
    ]),
  );
}

/** Acknowledgements may advance revision while a newer edit is still being saved. */
export function reconcileObject(
  local: CanvasObject,
  remote: CanvasObject,
  pending: CanvasObject | undefined,
): { object: CanvasObject; acknowledged: boolean } {
  if (remote.revision <= local.revision)
    return { object: local, acknowledged: false };
  const acknowledged =
    pending !== undefined && contentKey(pending) === contentKey(remote);
  return {
    object:
      pending && !acknowledged
        ? { ...local, revision: remote.revision }
        : remote,
    acknowledged,
  };
}
