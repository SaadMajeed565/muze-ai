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
