// Floating action bar for the current canvas selection. Presentation only; selection edits stay in CanvasWorkspace.
import type { ReactNode } from "react";
import {
  BringToFront,
  Copy,
  CopyPlus,
  Scissors,
  SendToBack,
  Trash2,
} from "lucide-react";

export interface SelectionActionsProps {
  count: number;
  /** Screen position of the bar's anchor edge, centered horizontally. */
  position: { left: number; top: number };
  /** "up" sits above the selection; "down" sits below it. */
  placement: "up" | "down";
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
  /** Extra controls, such as the shape properties toggle and its popover. */
  children?: ReactNode;
}

const MODIFIER =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform)
    ? "⌘"
    : "Ctrl+";

function ActionButton({
  label,
  shortcut,
  danger,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      className="selection-action"
      data-danger={danger ? "true" : undefined}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SelectionActions({
  count,
  position,
  placement,
  onCopy,
  onCut,
  onDuplicate,
  onBringToFront,
  onSendToBack,
  onDelete,
  children,
}: SelectionActionsProps): ReactNode {
  return (
    <div
      className="selection-actions"
      role="toolbar"
      aria-label="Selection actions"
      data-canvas-controls="true"
      data-vertical={placement}
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <span className="selection-actions-count" aria-live="polite">
        {count} selected
      </span>
      <span className="selection-actions-divider" />
      <ActionButton label="Copy" shortcut={`${MODIFIER}C`} onClick={onCopy}>
        <Copy size={15} />
      </ActionButton>
      <ActionButton label="Cut" shortcut={`${MODIFIER}X`} onClick={onCut}>
        <Scissors size={15} />
      </ActionButton>
      <ActionButton
        label="Duplicate"
        shortcut={`${MODIFIER}D`}
        onClick={onDuplicate}
      >
        <CopyPlus size={15} />
      </ActionButton>
      <span className="selection-actions-divider" />
      <ActionButton label="Bring to front" onClick={onBringToFront}>
        <BringToFront size={15} />
      </ActionButton>
      <ActionButton label="Send to back" onClick={onSendToBack}>
        <SendToBack size={15} />
      </ActionButton>
      {children}
      <span className="selection-actions-divider" />
      <ActionButton label="Delete" shortcut="Del" danger onClick={onDelete}>
        <Trash2 size={15} />
      </ActionButton>
    </div>
  );
}
