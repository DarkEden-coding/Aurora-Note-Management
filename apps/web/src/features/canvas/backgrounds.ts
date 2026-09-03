// Background pattern presentation for the canvas: CSS gradients for blank/ruled/grid/dot/solid. Presentation only; never affects persisted coordinates.
import type { CSSProperties } from "react";
import type { Background, Viewport } from "@aurora/shared";

export const DEFAULT_BACKGROUND: Background = {
  pattern: "dot-grid",
  color: "#1b1d21",
  patternColor: "#3a3f4a",
  spacing: 24,
};

/** Builds the CSS background for the pattern anchored to the world origin under the viewport transform. */
export function getBackgroundStyle(
  bg: Background,
  viewport: Viewport,
): CSSProperties {
  const size = bg.spacing * viewport.zoom;
  const offset = {
    x: -viewport.x * viewport.zoom,
    y: -viewport.y * viewport.zoom,
  };
  const ruled = `repeating-linear-gradient(0deg, ${bg.patternColor} 0px, ${bg.patternColor} 1px, transparent 1px, ${size}px)`;
  const gridV = `repeating-linear-gradient(90deg, ${bg.patternColor} 0px, ${bg.patternColor} 1px, transparent 1px, ${size}px)`;
  const dots = `radial-gradient(circle, ${bg.patternColor} 1px, transparent 1.5px)`;

  switch (bg.pattern) {
    case "solid":
      return { backgroundColor: bg.color };
    case "ruled":
      return {
        backgroundColor: bg.color,
        backgroundImage: ruled,
        backgroundSize: `${size}px ${size}px`,
        backgroundPosition: `${offset.x}px ${offset.y}px`,
      };
    case "square-grid":
      return {
        backgroundColor: bg.color,
        backgroundImage: `${ruled}, ${gridV}`,
        backgroundSize: `${size}px ${size}px, ${size}px ${size}px`,
        backgroundPosition: `${offset.x}px ${offset.y}px, ${offset.x}px ${offset.y}px`,
      };
    case "dot-grid":
      return {
        backgroundColor: bg.color,
        backgroundImage: dots,
        backgroundSize: `${size}px ${size}px`,
        backgroundPosition: `${offset.x}px ${offset.y}px`,
      };
    case "blank":
    default:
      return { backgroundColor: bg.color };
  }
}
