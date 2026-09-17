import { Calculator as CalculatorIcon, Delete, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { evaluateExpression } from "./parser.js";

const keys = [
  ["(", ")", "%", "/"],
  ["7", "8", "9", "*"],
  ["4", "5", "6", "-"],
  ["1", "2", "3", "+"],
  ["0", ".", "^", "="],
];

const CALCULATOR_WIDTH = 224;
const CALCULATOR_HEIGHT = 330;
const VIEWPORT_MARGIN = 8;

type Position = { x: number; y: number };

function clampPosition(position: Position): Position {
  return {
    x: Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        position.x,
        window.innerWidth - CALCULATOR_WIDTH - VIEWPORT_MARGIN,
      ),
    ),
    y: Math.max(
      VIEWPORT_MARGIN,
      Math.min(
        position.y,
        window.innerHeight - CALCULATOR_HEIGHT - VIEWPORT_MARGIN,
      ),
    ),
  };
}

export function Calculator() {
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState("");
  const [error, setError] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    start: Position;
    origin: Position;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    if (position !== null) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    setPosition(
      clampPosition({
        x: trigger.right - CALCULATOR_WIDTH,
        y: trigger.bottom + 8,
      }),
    );
  }, [open, position]);

  const append = (value: string) => {
    setExpression((current) => (error ? value : current + value));
    setError(false);
  };
  const calculate = () => {
    try {
      setExpression(String(evaluateExpression(expression)));
      setError(false);
    } catch {
      setError(true);
    }
  };

  return (
    <div className="calculator">
      <button
        ref={triggerRef}
        className="ghost icon-button"
        onClick={() => setOpen((value) => !value)}
        title="Calculator"
        aria-label="Open calculator"
        aria-expanded={open}
      >
        <CalculatorIcon size={16} />
      </button>
      {open && position !== null
        ? createPortal(
            <div
              className="calculator-popover"
              role="dialog"
              aria-label="Calculator"
              style={{ left: position.x, top: position.y }}
            >
              <div
                className="calculator-header"
                onPointerDown={(event) => {
                  event.preventDefault();
                  dragRef.current = {
                    pointerId: event.pointerId,
                    start: { x: event.clientX, y: event.clientY },
                    origin: position,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (drag?.pointerId !== event.pointerId) return;
                  setPosition(
                    clampPosition({
                      x: drag.origin.x + event.clientX - drag.start.x,
                      y: drag.origin.y + event.clientY - drag.start.y,
                    }),
                  );
                }}
                onPointerUp={(event) => {
                  if (dragRef.current?.pointerId !== event.pointerId) return;
                  dragRef.current = null;
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                }}
              >
                <span>Calculator</span>
                <button
                  className="ghost icon-button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => setOpen(false)}
                  aria-label="Close calculator"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="calculator-display">
                <input
                  ref={inputRef}
                  value={expression}
                  onChange={(event) => {
                    setExpression(event.target.value);
                    setError(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "=") {
                      event.preventDefault();
                      calculate();
                    }
                    if (event.key === "Escape") setOpen(false);
                  }}
                  aria-label="Calculator expression"
                  aria-invalid={error}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              {error ? (
                <span className="calculator-error">Invalid expression</span>
              ) : null}
              <div className="calculator-keys">
                <button
                  onClick={() => {
                    setExpression("");
                    setError(false);
                  }}
                >
                  Clear
                </button>
                <button
                  onClick={() => {
                    setExpression((current) => current.slice(0, -1));
                    setError(false);
                  }}
                  aria-label="Backspace"
                >
                  <Delete size={16} />
                </button>
                {keys.flat().map((key) => (
                  <button
                    key={key}
                    className={key === "=" ? "primary" : undefined}
                    onClick={() => (key === "=" ? calculate() : append(key))}
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
