// Selection state for the canvas workspace: primary/additive selection and hit-test integration. Object transforms stay in useViewport-agnostic gesture code.
import { useCallback, useMemo, useState } from "react";

export interface UseSelectionResult {
  selectedIds: ReadonlySet<string>;
  select: (id: string | null, additive?: boolean) => void;
  setSelection: (ids: Iterable<string>) => void;
  isSelected: (id: string) => boolean;
  clear: () => void;
}

export function useSelection(): UseSelectionResult {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const select = useCallback((id: string | null, additive: boolean = false) => {
    setSelectedIds((prev) => {
      if (id === null) return additive ? prev : new Set();
      if (additive) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  }, []);

  const setSelection = useCallback((ids: Iterable<string>) => {
    setSelectedIds(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds],
  );

  return useMemo(
    () => ({ selectedIds, select, setSelection, isSelected, clear }),
    [selectedIds, select, setSelection, isSelected, clear],
  );
}
