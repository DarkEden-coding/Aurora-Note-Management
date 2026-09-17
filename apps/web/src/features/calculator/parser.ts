/** Safely evaluates the calculator's small arithmetic grammar. */
export function evaluateExpression(source: string): number {
  const parser = new ExpressionParser(source);
  const result = parser.expression();
  parser.skipWhitespace();
  if (!parser.atEnd()) throw new Error("Unexpected input");
  if (!Number.isFinite(result)) throw new Error("Result is not finite");
  return result;
}

class ExpressionParser {
  private position = 0;

  constructor(private readonly source: string) {}

  expression(): number {
    let value = this.term();
    while (true) {
      if (this.consume("+")) value += this.term();
      else if (this.consume("-")) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.unary();
    while (true) {
      if (this.consume("*")) value *= this.unary();
      else if (this.consume("/")) {
        const divisor = this.unary();
        if (divisor === 0) throw new Error("Cannot divide by zero");
        value /= divisor;
      } else if (this.consume("%")) {
        const divisor = this.unary();
        if (divisor === 0) throw new Error("Cannot divide by zero");
        value %= divisor;
      } else return value;
    }
  }

  private unary(): number {
    if (this.consume("+")) return this.unary();
    if (this.consume("-")) return -this.unary();
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    return this.consume("^") ? base ** this.unary() : base;
  }

  private primary(): number {
    if (this.consume("(")) {
      const value = this.expression();
      if (!this.consume(")")) throw new Error("Expected closing parenthesis");
      return value;
    }
    return this.number();
  }

  private number(): number {
    this.skipWhitespace();
    const start = this.position;
    let digits = 0;
    while (this.isDigit(this.source[this.position])) {
      this.position++;
      digits++;
    }
    if (this.source[this.position] === ".") {
      this.position++;
      while (this.isDigit(this.source[this.position])) {
        this.position++;
        digits++;
      }
    }
    if (digits === 0) throw new Error("Expected a number");
    return Number(this.source.slice(start, this.position));
  }

  private consume(character: string): boolean {
    this.skipWhitespace();
    if (this.source[this.position] !== character) return false;
    this.position++;
    return true;
  }

  skipWhitespace(): void {
    while (/\s/.test(this.source[this.position] ?? "")) this.position++;
  }

  atEnd(): boolean {
    return this.position >= this.source.length;
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }
}
