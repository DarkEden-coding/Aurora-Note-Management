import { describe, expect, it } from "vitest";
import { evaluateExpression } from "./parser";

describe("evaluateExpression", () => {
  it("handles precedence, parentheses, decimals, modulo, and exponents", () => {
    expect(evaluateExpression("(2.5 + 1.5) * 3 % 7")).toBe(5);
    expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluateExpression("-2^2 + 2^-2")).toBe(-3.75);
  });

  it("rejects malformed input and invalid arithmetic", () => {
    expect(() => evaluateExpression("2 + nope")).toThrow();
    expect(() => evaluateExpression("(2 + 3")).toThrow();
    expect(() => evaluateExpression("1 / 0")).toThrow("divide by zero");
    expect(() => evaluateExpression("4 % 0")).toThrow("divide by zero");
  });
});
