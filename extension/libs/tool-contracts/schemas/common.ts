import { z } from "zod";

export const tabIdSchema = z.number().int().positive().describe("Chrome tab id");
export const frameIdSchema = z
  .number()
  .int()
  .min(0)
  .describe("Target iframe inside the tab, as reported by frames.list. 0 is the top frame; omit to default to the top frame");
export const windowIdSchema = z.number().int().describe("Chrome window id");
export const tabGroupIdSchema = z.number().int().describe("Chrome tab group id");
export const clientOpIdSchema = z.string().min(1).max(128).describe("Client-supplied correlation id");

export const urlSchema = z
  .string()
  .min(1)
  .max(2048)
  .describe("Absolute URL. Only http/https URLs can be navigated to or fetched.");

/**
 * Viewport/page coordinates shared by the granular dom.* tools: finite,
 * non-negative and bounded. Handlers must still clamp to the actual viewport
 * where a coordinate outside the visible page is meaningless.
 */
export const coordinateSchema = z.number().finite().min(0).max(100_000).describe("Coordinate in CSS pixels, 0..100000");

export const EmptyInput = z.object({}).strict();

export const TabInfo = z.object({
  id: tabIdSchema,
  index: z.number().int(),
  windowId: windowIdSchema,
  active: z.boolean(),
  pinned: z.boolean(),
  highlighted: z.boolean(),
  title: z.string().describe("May be empty until the page loads"),
  // Optional, not merely "may be omitted" in prose: handlers MUST omit url
  // for restricted URLs (chrome://, extension pages, web-store pages, …)
  // instead of returning it. The old schema declared url required while its
  // description said it could be omitted, so a handler that hid a restricted
  // URL failed output validation and one that returned it leaked it.
  url: z.string().max(2048).optional().describe("Omitted for restricted URLs"),
  status: z.enum(["loading", "complete", "unloaded", "unknown"]),
  groupId: z.number().int().describe("-1 when the tab is not in a group"),
  audible: z.boolean().optional(),
  discarded: z.boolean(),
  incognito: z.boolean(),
});

export type TabInfo = z.infer<typeof TabInfo>;

export const WindowInfo = z.object({
  id: windowIdSchema,
  focused: z.boolean(),
  state: z.enum(["normal", "minimized", "maximized", "fullscreen", "locked-fullscreen", "unknown"]),
  type: z.enum(["normal", "popup", "panel", "devtools", "unknown"]),
  tabCount: z.number().int(),
  activeTabId: tabIdSchema.optional(),
});

export type WindowInfo = z.infer<typeof WindowInfo>;

export const PageMetadata = z.object({
  title: z.string(),
  url: z.string(),
  canonicalUrl: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  faviconUrl: z.string().optional(),
  headings: z.array(z.object({ level: z.number().int().min(1).max(6), text: z.string() })),
  meta: z.array(z.object({ name: z.string(), content: z.string() })),
});

export type PageMetadata = z.infer<typeof PageMetadata>;
export type BoundedText = z.infer<typeof BoundedText>;
export type FillReport = z.infer<typeof FillReport>;
export type ElementRef = z.infer<typeof ElementRef>;

export const BoundedText = z.object({
  text: z.string(),
  totalChars: z.number().int().describe("Total characters available before truncation"),
  offset: z.number().int(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nullable().describe("Offset to pass to fetch the next chunk, or null at the end"),
});

export const ElementRef = z.object({
  ref: z.string().describe("Opaque handle returned by a previous find; stable for the current page state"),
  role: z.string().optional(),
  name: z.string().optional(),
  tagName: z.string(),
  text: z.string().optional(),
  selector: z.string().optional(),
});

export const FillReport = z.object({
  filled: z.array(z.object({ ref: z.string(), field: z.string(), value: z.string() })),
  skipped: z.array(z.object({ field: z.string(), reason: z.string() })),
});
