import { Calculator as CalculatorIcon, Delete, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { evaluateExpression } from "./parser.js";

const keys = [
  ["(", ")", "%", "/"],
  ["7", "8", "9", "*"],
  ["4", "5", "6", "-"],
  ["1", "2", "3", "+"],
  ["0", ".", "^", "="],
];

export function Calculator() {
  const [open, setOpen] = useState(false);
  const [expression, setExpression] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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
        className="ghost icon-button"
        onClick={() => setOpen((value) => !value)}
        title="Calculator"
        aria-label="Open calculator"
        aria-expanded={open}
      >
        <CalculatorIcon size={16} />
      </button>
      {open ? (
        <div
          className="calculator-popover"
          role="dialog"
          aria-label="Calculator"
        >
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
            <button
              className="ghost icon-button"
              onClick={() => setOpen(false)}
              aria-label="Close calculator"
            >
              <X size={15} />
            </button>
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
        </div>
      ) : null}
    </div>
  );
}
