// Draws a quad given in normalized coordinates over a photo or video frame of any size.
import type { ReactNode } from "react";
import type { Quad } from "./quadGeometry";

export function QuadOutline({
  quad,
  invalid = false,
}: {
  quad: Quad;
  invalid?: boolean;
}): ReactNode {
  const points = quad.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg
      className="scan-outline"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polygon
        points={points}
        data-invalid={invalid ? "true" : "false"}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
