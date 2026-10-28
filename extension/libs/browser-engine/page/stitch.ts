/**
 * Geometry for stitching a full page capture back together.
 *
 * A page is captured one viewport at a time. The last slice has to be pulled
 * back to the bottom of the page, so it overlaps the slice before it. Each
 * slice therefore knows the part of the document it contributes (`docStart` to
 * `docEnd`) and where the page was scrolled when it was taken (`scrollY`),
 * which is enough to work out which part of the image to keep and where the
 * result belongs on the final canvas.
 */

export interface StitchSlice {
  /** Where the retained content starts in the document, in CSS pixels. */
  docStart: number;
  /** Where the retained content ends in the document, in CSS pixels. */
  docEnd: number;
  /** Where the page was scrolled when the slice was taken, in CSS pixels. */
  scrollY: number;
}

export interface StitchRect {
  /** Top of the source region inside the captured image, in image pixels. */
  sy: number;
  /** Height of the source region inside the captured image, in image pixels. */
  sh: number;
  /** Top of the destination region on the stitched canvas, in canvas pixels. */
  dy: number;
  /** Height of the destination region on the stitched canvas, in canvas pixels. */
  dh: number;
}

export interface StitchSizes {
  /** Width of the captured image, in image pixels. */
  imageWidth: number;
  /** Height of the captured image, in image pixels. */
  imageHeight: number;
  /** Width of the stitched canvas, in canvas pixels. */
  canvasWidth: number;
  /** Height of the stitched canvas, in canvas pixels. */
  canvasHeight: number;
  /** Height of the browser viewport, in CSS pixels. */
  viewportHeight: number;
  /** Height of the document being captured, in CSS pixels. */
  documentHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Stitched-canvas safety bounds. A full-page stitch allocates one canvas
 * for the whole page, so an uncapped page is not just slow — at 2x DPR
 * the default 12,000 CSS px maxHeight is a 24,000 device-px tall canvas,
 * past Chrome's 16,384 px canvas dimension limit, and encoding it can
 * thrash past the 30s executor limit (the wiki + selenium fullPage
 * timeouts). Capping first and reporting the cap as a partial result is
 * honest bounding: the caller gets the top of the page fast, with the
 * reason, instead of a hang. 2^24 px area keeps even a PNG encode in
 * single-digit seconds on a typical machine.
 */
export const MAX_STITCH_DIMENSION_PX = 16_384;
export const MAX_STITCH_AREA_PX = 16_777_216;
/** A full-page capture is at most this many viewport slices. */
export const MAX_FULL_PAGE_PAGES = 40;

export interface CappedFullPage {
  /** Height actually captured, in CSS pixels (never more than the page). */
  totalHeight: number;
  /** Viewport slices needed for totalHeight. */
  pages: number;
  /** True when totalHeight is less than the page's scroll height. */
  partial: boolean;
  /** Human-readable reason when partial, undefined otherwise. */
  partialReason: string | undefined;
}

/**
 * Bound a full-page capture BEFORE any slice is taken. Each cap is
 * applied in turn and the tightest wins; a capped capture is a partial
 * result (top of the page, with the reason), never a hang and never a
 * silent crop. Pure, so it is unit-testable without a browser.
 */
export function capFullPageCapture(
  scrollHeight: number,
  viewportHeight: number,
  viewportWidth: number,
  devicePixelRatio: number,
  maxHeight: number,
): CappedFullPage {
  const vpH = Math.max(1, viewportHeight);
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const widthDev = Math.round(viewportWidth * dpr);
  let totalHeight = Math.min(scrollHeight, maxHeight);
  totalHeight = Math.min(totalHeight, Math.floor(MAX_STITCH_DIMENSION_PX / dpr));
  if (widthDev > 0) totalHeight = Math.min(totalHeight, Math.floor(MAX_STITCH_AREA_PX / widthDev / dpr));
  totalHeight = Math.min(totalHeight, MAX_FULL_PAGE_PAGES * vpH);
  totalHeight = Math.max(1, totalHeight);
  const pages = Math.max(1, Math.ceil(totalHeight / vpH));
  const partial = totalHeight < scrollHeight;
  return {
    totalHeight,
    pages,
    partial,
    partialReason: partial
      ? `Full-page capture capped at ${totalHeight} of ${scrollHeight} CSS px (stitched-canvas bound: max ${MAX_STITCH_DIMENSION_PX} device px per side, ${MAX_STITCH_AREA_PX.toLocaleString("en-US")} device px area, ${MAX_FULL_PAGE_PAGES} slices). The image covers the top of the page; capture the visible viewport per section for the rest.`
      : undefined,
  };
}

/**
 * Work out which rectangle of the captured image to draw and where it goes on
 * the stitched canvas.
 */
export function sliceGeometry(slice: StitchSlice, sizes: StitchSizes): StitchRect {
  const { imageHeight, canvasHeight, viewportHeight, documentHeight } = sizes;

  // The image shows the document between `scrollY` and `scrollY +
  // viewportHeight`. Only the part between `docStart` and `docEnd` is new.
  const sourceTop = ((slice.docStart - slice.scrollY) / viewportHeight) * imageHeight;
  const sourceHeight = ((slice.docEnd - slice.docStart) / viewportHeight) * imageHeight;

  const destinationTop = (slice.docStart / documentHeight) * canvasHeight;
  const destinationHeight = ((slice.docEnd - slice.docStart) / documentHeight) * canvasHeight;

  const sy = clamp(Math.round(sourceTop), 0, Math.max(0, imageHeight - 1));
  const sh = clamp(Math.round(sourceHeight), 1, Math.max(1, imageHeight - sy));
  const dy = clamp(Math.round(destinationTop), 0, Math.max(0, canvasHeight - 1));
  const dh = clamp(Math.round(destinationHeight), 1, Math.max(1, canvasHeight - dy));

  return { sy, sh, dy, dh };
}
