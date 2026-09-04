// Public contract for the canvas feature: CanvasWorkspace, demo content, viewport/culling/page-layout math, object helpers, gesture hooks, and SyncOperation factories.
import "./canvasStyles.css";

export { CanvasWorkspace } from "./CanvasWorkspace";
export type { CanvasWorkspaceProps } from "./CanvasWorkspace";

export { CanvasToolbar } from "./CanvasToolbar";
export type { CanvasTool } from "./CanvasToolbar";

export { SceneObject, PressureStrokePath, HtmlObject } from "./ObjectRenderer";
export type { HtmlObjectCallbacks, HtmlObjectProps } from "./ObjectRenderer";

export { buildDemoObjects } from "./DemoContent";

export { DEFAULT_BACKGROUND, getBackgroundStyle } from "./backgrounds";

export {
  DEFAULT_OVERSCAN,
  queryVisibleObjects,
  sortByZIndex,
  sortByZIndexDescending,
} from "./culling";

export {
  MIN_ZOOM,
  MAX_ZOOM,
  makeViewport,
  clampZoom,
  screenToCanvas,
  canvasToScreen,
  visibleCanvasBounds,
  panViewport,
  zoomViewportAround,
  expandBounds,
  boundsIntersect,
  boundsContainPoint,
  translateBounds,
  unionBounds,
} from "./viewport";
export type { Point } from "./viewport";

export { useViewport, makeInitialViewport } from "./useViewport";
export type { UseViewportResult, ContainerSize } from "./useViewport";

export { usePenCapture } from "./usePenCapture";
export type {
  PenCaptureOptions,
  PenCaptureHandlers,
  UsePenCaptureResult,
} from "./usePenCapture";

export { useSelection } from "./useSelection";
export type { UseSelectionResult } from "./useSelection";

export {
  MIN_BOUNDS_SIZE,
  makeCanvasObject,
  maxZIndex,
  nextZIndex,
  hitTestTopmost,
  hitTestLineObject,
  pointsToBounds,
  dragBoundsFree,
  lineGeometryFromDrag,
  applyResize,
  handlePositions,
  handleAtPoint,
  recomputeStrokeBounds,
  getRichTextDoc,
  getStrokePoints,
  setStrokePayload,
  getStrokeColor,
  getStrokeBaseWidth,
  getShapeStrokeWidth,
  getShapeColor,
  getShapeFill,
  getShapeLineStyle,
  getShapeCornerRadius,
  getShapeDashArray,
  getLineEndpoints,
  getArrowHeadGeometry,
  setLineEndpointPayload,
  resizeObjectToBounds,
  getStickyText,
  getStickyColor,
  getImageSrc,
  getImageAlt,
  getAttachmentName,
  getAttachmentSize,
  getAttachmentFileId,
  getPdfPageReference,
} from "./objects";
export type {
  StrokePoint,
  Handle,
  PdfPageReference,
  MakeCanvasObjectInput,
  ShapeLineStyle,
  LineEndpoints,
  LineDragGeometry,
  ArrowHeadGeometry,
} from "./objects";

export {
  newId,
  getDeviceId,
  makeUpsertOperation,
  makeDeleteOperation,
} from "./operations";

export {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  PAGE_GAP,
  MAX_OBJECTS_PER_NOTE,
  DEMO_OWNER_ID,
  pagedPageFrame,
  pagedPageIndexAtY,
  pagedPageCount,
  fixedAxis,
  clampBoundsToMode,
  clampBoundsToRegion,
  pageFrames,
  pageFrameAtPoint,
  pagedPageIndexOfPoint,
  translateBoundsInMode,
} from "./pageLayout";
