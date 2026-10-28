import { describe, expect, it } from "vitest";
import { sliceGeometry, type StitchSizes } from "../libs/browser-engine/page/stitch.js";

const VIEWPORT = 800;
const DOCUMENT = 2000;
const DPR = 2;

/** A capture of the viewport at 2x device pixel ratio. */
const sizes: StitchSizes = {
  imageWidth: 1600,
  imageHeight: VIEWPORT * DPR,
  canvasWidth: 1600,
  canvasHeight: DOCUMENT * DPR,
  viewportHeight: VIEWPORT,
  documentHeight: DOCUMENT,
};

describe("slice geometry", () => {
  it("keeps the whole image for a slice that lines up with the viewport", () => {
    const rect = sliceGeometry({ docStart: 0, docEnd: VIEWPORT, scrollY: 0 }, sizes);
    expect(rect.sy).toBe(0);
    expect(rect.sh).toBe(VIEWPORT * DPR);
    expect(rect.dy).toBe(0);
    expect(rect.dh).toBe(VIEWPORT * DPR);
  });

  it("places the second slice directly below the first", () => {
    const rect = sliceGeometry({ docStart: VIEWPORT, docEnd: VIEWPORT * 2, scrollY: VIEWPORT }, sizes);
    expect(rect.sy).toBe(0);
    expect(rect.sh).toBe(VIEWPORT * DPR);
    expect(rect.dy).toBe(VIEWPORT * DPR);
    expect(rect.dh).toBe(VIEWPORT * DPR);
  });

  it("does not overlap the slice before it", () => {
    const first = sliceGeometry({ docStart: 0, docEnd: VIEWPORT, scrollY: 0 }, sizes);
    const second = sliceGeometry({ docStart: VIEWPORT, docEnd: VIEWPORT * 2, scrollY: VIEWPORT }, sizes);
    expect(first.dy + first.dh).toBe(second.dy);
  });

  it("cuts the overlap off the top of the last slice", () => {
    // 2000px of document in 800px viewports is 2.5 viewports, so the last
    // slice is pulled back to 1200 and overlaps the second slice by 400px.
    const last = sliceGeometry({ docStart: VIEWPORT * 2, docEnd: DOCUMENT, scrollY: DOCUMENT - VIEWPORT }, sizes);
    expect(last.sy).toBe((VIEWPORT * DPR) / 2);
    expect(last.sh).toBe((VIEWPORT * DPR) / 2);
    expect(last.dy).toBe(VIEWPORT * 2 * DPR);
    expect(last.dh).toBe((DOCUMENT - VIEWPORT * 2) * DPR);
  });

  it("fills the canvas exactly", () => {
    const slices = [
      { docStart: 0, docEnd: VIEWPORT, scrollY: 0 },
      { docStart: VIEWPORT, docEnd: VIEWPORT * 2, scrollY: VIEWPORT },
      { docStart: VIEWPORT * 2, docEnd: DOCUMENT, scrollY: DOCUMENT - VIEWPORT },
    ];
    const rects = slices.map((s) => sliceGeometry(s, sizes));
    const covered = rects.reduce((total, r) => total + r.dh, 0);
    expect(covered).toBe(sizes.canvasHeight);
    expect(rects[rects.length - 1].dy + rects[rects.length - 1].dh).toBe(sizes.canvasHeight);
  });

  it("never draws outside the image or the canvas", () => {
    const rect = sliceGeometry({ docStart: DOCUMENT - 10, docEnd: DOCUMENT, scrollY: DOCUMENT - VIEWPORT }, sizes);
    expect(rect.sy + rect.sh).toBeLessThanOrEqual(sizes.imageHeight);
    expect(rect.dy + rect.dh).toBeLessThanOrEqual(sizes.canvasHeight);
  });

  it("handles a page that fits in a single viewport", () => {
    const single: StitchSizes = { ...sizes, canvasHeight: 400 * DPR, documentHeight: 400 };
    const rect = sliceGeometry({ docStart: 0, docEnd: 400, scrollY: 0 }, single);
    expect(rect.sh).toBe(400 * DPR);
    expect(rect.dh).toBe(400 * DPR);
  });

  it("copes with a capture that came back at a different scale", () => {
    // A browser zoom of 1.25x makes the image taller than the page metrics
    // suggest. The geometry is proportional, so it still lines up.
    const zoomed: StitchSizes = { ...sizes, imageHeight: VIEWPORT * DPR * 1.25 };
    const rect = sliceGeometry({ docStart: VIEWPORT, docEnd: VIEWPORT * 2, scrollY: VIEWPORT }, zoomed);
    expect(rect.sy).toBe(0);
    expect(rect.sh).toBe(VIEWPORT * DPR * 1.25);
    expect(rect.dy).toBe(VIEWPORT * DPR);
  });
});
