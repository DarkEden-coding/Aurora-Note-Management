import { HIGHLIGHTER_OPACITY, type StrokePoint } from "./objects";

/** Incremental screen-space ink; each sample paints only its newest segment. */
export class InkPreview {
  private context: CanvasRenderingContext2D | null = null;
  private previous: StrokePoint | null = null;
  private zoom = 1;
  private width = 2.5;
  private highlighter = false;

  begin(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    color: string,
    baseWidth: number,
    zoom: number,
    dpr: number,
    highlighter = false,
  ): void {
    const ratio = Math.min(2, Math.max(1, dpr));
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    this.context = canvas.getContext("2d", { desynchronized: true });
    this.previous = null;
    this.zoom = zoom;
    this.width = baseWidth;
    this.highlighter = highlighter;
    // Highlighter ink is painted opaque and faded as a layer, matching the committed stroke.
    canvas.style.opacity = highlighter ? String(HIGHLIGHTER_OPACITY) : "";
    if (!this.context) return;
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.context.strokeStyle = color;
    this.context.fillStyle = color;
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
  }

  private lineWidth(pressure: number): number {
    return this.highlighter
      ? this.width * this.zoom
      : Math.max(0.5, this.width * (0.3 + pressure)) * this.zoom;
  }

  append(point: StrokePoint): void {
    const ctx = this.context;
    if (!ctx) return;
    const previous = this.previous;
    if (previous) {
      ctx.lineWidth = this.lineWidth(previous.pressure);
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(
        point.x,
        point.y,
        this.lineWidth(point.pressure) / 2,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    this.previous = point;
  }

  clear(): void {
    if (this.context)
      this.context.clearRect(
        0,
        0,
        this.context.canvas.width,
        this.context.canvas.height,
      );
    this.previous = null;
  }
}
