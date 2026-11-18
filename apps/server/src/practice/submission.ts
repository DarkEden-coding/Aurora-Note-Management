// Builds what Claude gets for a submitted page: card and region bounds, ink geometry, free space, and the page image (optionally cropped/scaled) plus a final-answer crop.
import type { Bounds, CanvasObject, PracticeCardRegion } from "@aurora/shared";
import { practiceTagOf } from "./marks.js";
import {
  CARD_WIDTH,
  CARD_X,
  CARD_Y,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  boundsIntersect,
  pageFrame,
} from "./page.js";
import {
  freeRegions,
  inkClusters,
  padToPage,
  snapToGrid,
  unionBounds,
} from "./geometry.js";
import { RENDER_SCALE, renderPagePng, type RenderTarget } from "./render.js";

const FINAL_ANSWER_SCALE = 2;
const FINAL_ANSWER_PADDING = 12;

export type ImageOptions = {
  // "ink": only the area around the user's writing, card regions and this question's marks.
  crop: "page" | "ink";
  scale: number;
  padding: number;
};

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = {
  crop: "page",
  scale: RENDER_SCALE,
  padding: 32,
};

export type PageGeometry = {
  card: Bounds;
  regions: PracticeCardRegion[];
  ink: { bounds: Bounds | null; clusters: Bounds[] };
  freeRegions: Bounds[];
};

export type PageImage = {
  png: Buffer;
  // The page-relative area the image shows, and its pixels per page unit.
  area: Bounds & { scale: number };
};

const round = (n: number): number => Math.round(n * 10) / 10;

function roundBounds(b: Bounds): Bounds {
  return {
    x: round(b.x),
    y: round(b.y),
    width: round(b.width),
    height: round(b.height),
  };
}

/** Page-relative bounds of an object, clipped to the page. */
function onPageBounds(object: CanvasObject, frameY: number): Bounds {
  return padToPage({ ...object.bounds, y: object.bounds.y - frameY }, 0);
}

/**
 * Splits a page's objects into the question card, user ink and practice marks, and returns
 * their geometry in page coordinates. `cardRegions` are card-relative, as the browser measured them.
 */
export function describePage(
  objects: CanvasObject[],
  pageIndex: number,
  cardRegions: PracticeCardRegion[],
): PageGeometry {
  const frame = pageFrame(pageIndex);
  const onPage = objects.filter((o) => boundsIntersect(o.bounds, frame));
  const prompt = onPage.find((o) => practiceTagOf(o)?.role === "prompt");
  const card = prompt
    ? onPageBounds(prompt, frame.y)
    : { x: CARD_X, y: CARD_Y, width: CARD_WIDTH, height: 0 };
  const inkBoxes = onPage
    .filter((o) => practiceTagOf(o) === null)
    .map((o) => onPageBounds(o, frame.y));
  const occupied = onPage.map((o) => onPageBounds(o, frame.y));
  const regions = cardRegions.map((region) => ({
    ...region,
    ...roundBounds({ ...region, x: region.x + card.x, y: region.y + card.y }),
  }));
  const inkBounds = unionBounds(inkBoxes);
  const clusters = inkClusters(inkBoxes);
  return {
    card: roundBounds(card),
    regions,
    ink: {
      bounds: inkBounds && roundBounds(inkBounds),
      clusters: clusters.map(roundBounds),
    },
    freeRegions: freeRegions(occupied, clusters).map(roundBounds),
  };
}

/** Page area for the main image: the whole page, or the ink/regions/marks crop snapped to the grid. */
function imageArea(
  objects: CanvasObject[],
  target: RenderTarget,
  geometry: PageGeometry,
  options: ImageOptions,
): Bounds {
  const page = { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT };
  if (options.crop === "page") return page;
  const frame = pageFrame(target.pageIndex);
  const marks = objects
    .filter((o) => boundsIntersect(o.bounds, frame))
    .filter((o) => {
      const tag = practiceTagOf(o);
      return tag !== null && tag.role !== "prompt" && tag.role !== "summary";
    })
    .map((o) => onPageBounds(o, frame.y));
  const content = unionBounds([
    ...(geometry.ink.bounds ? [geometry.ink.bounds] : []),
    ...geometry.regions,
    ...marks,
  ]);
  return content ? snapToGrid(padToPage(content, options.padding)) : page;
}

/** The page image, plus a close-up of the first final-answer box when the card has one. */
export async function renderPageImages(
  objects: CanvasObject[],
  target: Omit<RenderTarget, "regions">,
  geometry: PageGeometry,
  options: ImageOptions,
): Promise<{ page: PageImage; finalAnswer: PageImage | null }> {
  const withRegions = { ...target, regions: geometry.regions };
  const area = imageArea(objects, target, geometry, options);
  const page = {
    png: await renderPagePng(objects, withRegions, {
      view: area,
      scale: options.scale,
    }),
    area: { ...area, scale: options.scale },
  };
  const box = geometry.regions.find((r) => r.kind === "finalAnswer");
  if (!box) return { page, finalAnswer: null };
  const crop = roundBounds(padToPage(box, FINAL_ANSWER_PADDING));
  return {
    page,
    finalAnswer: {
      png: await renderPagePng(objects, withRegions, {
        view: crop,
        scale: FINAL_ANSWER_SCALE,
      }),
      area: { ...crop, scale: FINAL_ANSWER_SCALE },
    },
  };
}
