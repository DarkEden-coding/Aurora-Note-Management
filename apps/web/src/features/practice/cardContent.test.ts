// @vitest-environment jsdom
// Verifies practice card sanitizing and math rendering: unsafe markup is removed, math renders with KaTeX, and code and escaped dollars stay literal.
import { describe, expect, it } from "vitest";
import { buildCardContent, splitMath } from "./cardContent";

function render(html: string): HTMLDivElement {
  const container = document.createElement("div");
  container.append(buildCardContent(html));
  return container;
}

describe("practice card content", () => {
  it("keeps rich layouts: styles, grids, tables, columns, inline SVG and data: images", () => {
    const card = render(
      `<style>.grid { display: grid; grid-template-columns: 1fr 1fr }</style>` +
        `<div class="grid" style="columns: 2; border: 1px solid #fff; font-family: serif">` +
        `<table><tr><th>F</th><td>$F=ma$</td></tr></table>` +
        `<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#1f6feb"/></svg>` +
        `<img src="data:image/png;base64,AAAA"></div>`,
    );
    expect(card.querySelector("style")?.textContent).toContain(
      "grid-template-columns",
    );
    expect(card.querySelector(".grid")?.getAttribute("style")).toContain(
      "columns: 2",
    );
    expect(card.querySelector("td .katex")).not.toBeNull();
    expect(card.querySelector("svg circle")?.getAttribute("fill")).toBe(
      "#1f6feb",
    );
    expect(card.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image/,
    );
  });

  it("strips scripts, event handlers, embeds, and external URLs", () => {
    const card = render(
      `<style>@import url(https://evil.test/a.css); .x { background: url(https://evil.test/b.png) }</style>` +
        `<p onclick="alert(1)" style="color: red; background: url('https://evil.test/c.png')">Hi</p>` +
        `<script>alert(1)</script><iframe src="https://evil.test"></iframe>` +
        `<img src="https://evil.test/d.png" onerror="alert(1)"><img src="data:image/png;base64,AAAA">` +
        `<a href="javascript:alert(1)">x</a><svg><use href="https://evil.test/e.svg#a"/><circle r="4"/></svg>`,
    );
    const html = card.innerHTML;
    expect(html).not.toMatch(
      /script|iframe|onclick|onerror|javascript:|evil\.test/,
    );
    expect(card.querySelector("p")?.getAttribute("style")).toContain(
      "color: red",
    );
    expect(card.querySelector("style")?.textContent).toContain(".x");
    expect(card.querySelectorAll("img")[1]?.getAttribute("src")).toMatch(
      /^data:image\/png/,
    );
    expect(card.querySelector("svg circle")).not.toBeNull();
  });

  it("renders inline and display math with KaTeX", () => {
    const card = render(
      "<p>Solve $x^2 = 4$ then</p><p>$$\\int_0^1 x\\,dx$$</p>",
    );
    expect(card.querySelectorAll(".katex")).toHaveLength(2);
    expect(card.querySelector(".katex-display")).not.toBeNull();
    expect(card.textContent).toContain("Solve ");
    expect(card.querySelector("p")?.textContent).not.toContain("$");
  });

  it("leaves code, escaped dollars, and prices untouched", () => {
    const card = render(
      "<p>Costs \\$5 or $5 and $10</p><code>$x^2$</code><pre>\\(y\\)</pre>",
    );
    expect(card.querySelector(".katex")).toBeNull();
    expect(card.querySelector("p")?.textContent).toBe("Costs $5 or $5 and $10");
    expect(card.querySelector("code")?.textContent).toBe("$x^2$");
    expect(card.querySelector("pre")?.textContent).toBe("\\(y\\)");
  });

  it("splits all four delimiter styles", () => {
    expect(splitMath("a \\(b\\) c \\[d\\] $e$ $$f$$")).toEqual([
      { kind: "text", text: "a " },
      { kind: "math", tex: "b", display: false },
      { kind: "text", text: " c " },
      { kind: "math", tex: "d", display: true },
      { kind: "text", text: " " },
      { kind: "math", tex: "e", display: false },
      { kind: "text", text: " " },
      { kind: "math", tex: "f", display: true },
    ]);
  });
});
