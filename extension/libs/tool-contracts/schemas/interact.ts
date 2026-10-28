import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { ElementRef, FillReport, coordinateSchema, frameIdSchema, tabIdSchema } from "./common.js";

const tabRef = { tabId: tabIdSchema.optional().describe("Defaults to the active tab"), frameId: frameIdSchema.optional() };

const findBy = z.enum(["selector", "text", "label", "placeholder", "role", "name"]);
const findInput = z
  .object({
    ...tabRef,
    by: findBy.describe("Strategy used to locate elements"),
    value: z.string().min(1).max(512).describe("Selector or text to match"),
    role: z.string().max(64).optional().describe("When by=role, the ARIA role"),
    name: z.string().max(256).optional().describe("When by=role, accessible name substring"),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const domFind: ToolDefinition = {
  name: "dom.find",
  title: "Find elements",
  description:
    "Find elements using accessibility-first strategies (role/name/label/placeholder/text) or an explicit CSS selector. Returns opaque refs used by other dom.* and forms.* tools.",
  category: "dom",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: findInput,
  output: z.object({ elements: z.array(ElementRef) }).strict(),
};

export const domRead: ToolDefinition = {
  name: "dom.read",
  title: "Read element",
  description: "Read an element's visible text and a bounded set of permitted attributes.",
  category: "dom",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128), attributes: z.array(z.string()).max(20).default([]) }).strict(),
  output: z
    .object({
      text: z.string(),
      attributes: z.record(z.string(), z.string()),
      element: z
        .object({
          tagName: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
          id: z.string().optional(),
          autocomplete: z.string().optional(),
          ariaLabel: z.string().optional(),
          metaName: z.string().optional(),
        })
        .optional(),
    })
    .strict(),
};

export const domClick: ToolDefinition = {
  name: "dom.click",
  title: "Click element",
  description: "Click an element. The handler dispatches trusted pointer/mouse events at the element's center.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      ref: z.string().min(1).max(128),
      button: z.enum(["left", "right", "middle"]).default("left"),
      waitMs: z.number().int().min(0).max(10_000).default(0),
      waitForNetworkIdle: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ clicked: z.literal(true), ref: z.string(), url: z.string().optional(), hardware: z.boolean().optional(), method: z.enum(["cdp", "synthetic"]).optional() }).strict(),
};

export const domFocus: ToolDefinition = {
  name: "dom.focus",
  title: "Focus element",
  description: "Move focus to an element.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ focused: z.literal(true), ref: z.string() }).strict(),
};

export const domHover: ToolDefinition = {
  name: "dom.hover",
  title: "Hover element",
  description: "Dispatch hover events over an element where supported by the page.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ hovered: z.literal(true), ref: z.string() }).strict(),
};

export const domScroll: ToolDefinition = {
  name: "dom.scroll",
  title: "Scroll page",
  description: "Scroll the page up, down, to the top, or to the bottom.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, direction: z.enum(["up", "down", "top", "bottom"]), amount: z.number().int().min(0).max(20_000).default(600) }).strict(),
  output: z.object({ scrollY: z.number(), scrollHeight: z.number() }).strict(),
};

export const domScrollTo: ToolDefinition = {
  name: "dom.scrollTo",
  title: "Scroll to element",
  description: "Scroll an element into view.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ scrolled: z.literal(true), ref: z.string() }).strict(),
};

export const domSelect: ToolDefinition = {
  name: "dom.select",
  title: "Select option",
  description: "Choose an option in a <select> element by value or visible label.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128), value: z.string().max(512).optional(), label: z.string().max(512).optional() }).strict(),
  output: z.object({ selected: z.boolean(), value: z.string() }).strict(),
};

export const domSetChecked: ToolDefinition = {
  name: "dom.setChecked",
  title: "Toggle checkbox",
  description: "Set a checkbox's checked state.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128), checked: z.boolean() }).strict(),
  output: z.object({ checked: z.boolean() }).strict(),
};

export const domSetRadio: ToolDefinition = {
  name: "dom.setRadio",
  title: "Select radio",
  description: "Select a radio button.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ checked: z.boolean() }).strict(),
};

export const domFill: ToolDefinition = {
  name: "dom.fill",
  title: "Fill field",
  description: "Set the value of a text input, textarea or contenteditable element. Does not submit.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128), value: z.string().max(10_000) }).strict(),
  output: z.object({ filled: z.literal(true), ref: z.string() }).strict(),
};

export const domType: ToolDefinition = {
  name: "dom.type",
  title: "Type text",
  description: "Type text into an element (uses focus + key events).",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      ref: z.string().min(1).max(128),
      text: z.string().max(10_000),
      waitMs: z.number().int().min(0).max(10_000).default(0),
      waitForNetworkIdle: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ typed: z.literal(true), ref: z.string(), hardware: z.boolean().optional(), method: z.enum(["cdp", "synthetic"]).optional() }).strict(),
};

export const domPress: ToolDefinition = {
  name: "dom.press",
  title: "Press key",
  description: "Press a key on an element (Enter, Escape, Tab, arrows, etc.).",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128), key: z.string().min(1).max(32), modifiers: z.array(z.enum(["Control", "Shift", "Alt", "Meta"])).default([]) }).strict(),
  output: z.object({ pressed: z.literal(true), ref: z.string(), hardware: z.boolean().optional(), method: z.enum(["cdp", "synthetic"]).optional() }).strict(),
};

export const domClickAt: ToolDefinition = {
  name: "dom.clickAt",
  title: "Click at coordinates",
  description:
    "Click at coordinates. Default space is CSS viewport pixels (same as page.snapshot node boxes). If coordinateSpace is screenshot, x/y are divided by devicePixelRatio. Works on canvas/SVG via pointer events.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      x: coordinateSchema,
      y: coordinateSchema,
      coordinateSpace: z.enum(["css", "screenshot"]).default("css"),
      waitMs: z.number().int().min(0).max(10_000).default(0),
      waitForNetworkIdle: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ clicked: z.literal(true), x: z.number(), y: z.number(), tagName: z.string().optional(), hardware: z.boolean().optional(), method: z.enum(["cdp", "synthetic"]).optional() }).strict(),
};

export const domMoveTo: ToolDefinition = {
  name: "dom.moveTo",
  title: "Move mouse",
  description: "Move mouse to coordinates.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, x: coordinateSchema, y: coordinateSchema }).strict(),
  output: z.object({ moved: z.literal(true), x: z.number(), y: z.number(), method: z.enum(["cdp", "synthetic"]).optional() }).strict(),
};

export const domDrag: ToolDefinition = {
  name: "dom.drag",
  title: "Drag element",
  description: "Drag from one element to another.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, fromRef: z.string().min(1).max(128), toRef: z.string().min(1).max(128) }).strict(),
  output: z.object({ dragged: z.literal(true), fromRef: z.string(), toRef: z.string() }).strict(),
};

export const domDragAt: ToolDefinition = {
  name: "dom.dragAt",
  title: "Drag between coordinates",
  description: "Drag from (x1,y1) to (x2,y2).",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      x1: coordinateSchema,
      y1: coordinateSchema,
      x2: coordinateSchema,
      y2: coordinateSchema,
      coordinateSpace: z.enum(["css", "screenshot"]).default("css"),
    })
    .strict(),
  output: z.object({ dragged: z.literal(true), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), method: z.enum(["cdp", "synthetic"]).optional() }).strict(),
};

export const domBoundingBox: ToolDefinition = {
  name: "dom.boundingBox",
  title: "Element bounds",
  description: "Get the bounding box of an element in page coordinates and in viewport coordinates.",
  category: "dom",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z
    .object({
      x: z.number().describe("Left edge in page coordinates"),
      y: z.number().describe("Top edge in page coordinates"),
      viewportX: z.number(),
      viewportY: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .strict(),
};

export const domVisible: ToolDefinition = {
  name: "dom.visible",
  title: "Element visible",
  description: "Check whether an element is rendered and whether something else is covering it.",
  category: "dom",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ visible: z.boolean(), occluded: z.boolean().optional() }).strict(),
};

export const domClear: ToolDefinition = {
  name: "dom.clear",
  title: "Clear field",
  description: "Clear the value of a text field.",
  category: "dom",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ cleared: z.literal(true), ref: z.string() }).strict(),
};

export const domSubmit: ToolDefinition = {
  name: "dom.submit",
  title: "Submit form",
  description: "Submit a form or click a submit control. Consequential: always requires fresh user approval.",
  category: "forms",
  risk: "consequential",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128), expectedAction: z.string().max(512).optional() }).strict(),
  output: z.object({ submitted: z.literal(true), ref: z.string(), dispatched: z.boolean().optional(), verified: z.boolean().optional() }).strict(),
};

export const domWaitFor: ToolDefinition = {
  name: "dom.waitFor",
  title: "Wait for element",
  description: "Wait until an element matching the given strategy appears, or time out.",
  category: "dom",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      by: findBy,
      value: z.string().min(1).max(512),
      role: z.string().max(64).optional(),
      name: z.string().max(256).optional(),
      timeoutMs: z.number().int().min(500).max(120_000).default(10_000),
      visible: z.boolean().default(true),
    })
    .strict(),
  output: z.object({ found: z.boolean(), ref: z.string().nullable(), timedOut: z.boolean() }).strict(),
};

export const formsInspect: ToolDefinition = {
  name: "forms.inspect",
  title: "Inspect forms",
  description: "List visible forms and their fields (label, type, required). Never returns values of password, hidden or payment fields.",
  category: "forms",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef }).strict(),
  output: z
    .object({
      forms: z.array(
        z.object({
          ref: z.string(),
          action: z.string().optional(),
          method: z.string().optional(),
          fields: z.array(
            z.object({
              ref: z.string(),
              label: z.string(),
              type: z.string(),
              required: z.boolean(),
              options: z.array(z.string()).optional(),
            }),
          ),
        }),
      ),
    })
    .strict(),
};

export const formsFill: ToolDefinition = {
  name: "forms.fill",
  title: "Fill form",
  description: "Fill approved form fields by ref. Does not submit. Refuses password, hidden and payment fields.",
  category: "forms",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      fields: z.array(z.object({ ref: z.string().min(1).max(128), value: z.string().max(10_000) })).min(1).max(100),
    })
    .strict(),
  output: FillReport,
};

export const formsSubmit: ToolDefinition = {
  name: "forms.submit",
  title: "Submit approved form",
  description:
    "Submit a form after fields were filled. Consequential and always requires fresh, single-use user approval identifying the form and target.",
  category: "forms",
  risk: "consequential",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, formRef: z.string().min(1).max(128), expectedAction: z.string().max(512).optional() }).strict(),
  output: z.object({ submitted: z.literal(true), formRef: z.string(), evidence: z.string().optional(), dispatched: z.boolean().optional(), verified: z.boolean().optional() }).strict(),
};

export const formsPreview: ToolDefinition = {
  name: "forms.preview",
  title: "Preview form",
  description: "Preview a form with current values.",
  category: "forms",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ fields: z.array(z.object({ ref: z.string(), label: z.string(), type: z.string(), required: z.boolean(), options: z.array(z.string()).optional() })) }).strict(),
};

export const domShadow: ToolDefinition = {
  name: "dom.shadow",
  title: "List shadow roots",
  description:
    "List the open shadow roots of the page and the elements they contain. Shadow DOM is where many component based applications keep their real interface.",
  category: "dom",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, maxDepth: z.number().int().min(1).max(10).default(4) }).strict(),
  output: z
    .object({
      hosts: z.array(
        z.object({
          tagName: z.string(),
          id: z.string().optional(),
          className: z.string().optional(),
          childCount: z.number().int(),
          depth: z.number().int(),
        }),
      ),
    })
    .strict(),
};

export const formsUpload: ToolDefinition = {
  name: "forms.upload",
  title: "Upload files to a file input",
  description:
    "Attach files to a file input. The files are provided inline as base64 and never leave the browser. Requires fresh user approval. Inline cap: 15,000,000 base64 characters per file (about 11.25 MB decoded) — the error message must state this character cap, not a mismatched MB figure.",
  category: "forms",
  risk: "consequential",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      ref: z.string().min(1).max(128).describe("Ref of a file input element"),
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(255),
            mimeType: z.string().max(128).default("application/octet-stream"),
            dataBase64: z.string().min(1).max(15_000_000),
          }),
        )
        .min(1)
        .max(5),
    })
    .strict(),
  output: z.object({ uploaded: z.number().int(), names: z.array(z.string()) }).strict(),
};

export const formsSetFile: ToolDefinition = {
  name: "forms.setFile",
  title: "Set files on a file input",
  description:
    "Set files on a file input using the attached files store or inline base64. Uses DataTransfer (no file picker). Does not open the picker. Inline cap: 35,000,000 base64 characters per file (about 26.25 MB decoded).",
  category: "forms",
  risk: "consequential",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      selector: z.string().min(1).max(512).optional().describe("CSS selector for the input[type=file] element"),
      ref: z.string().min(1).max(128).optional().describe("Element ref of the input[type=file] element (from forms.inspect / dom.find); an exact registry lookup, never a re-query. Takes effect only when selector is absent."),
      fileId: z.string().min(1).max(128).optional().describe("File id from the files store"),
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(255),
            mimeType: z.string().max(128).default("application/octet-stream"),
            dataBase64: z.string().min(1).max(35_000_000),
          }),
        )
        .min(1)
        .max(5)
        .optional(),
    })
    .refine((data: any) => Boolean(data.selector) || Boolean(data.ref), {
      message: "Either selector or ref must be provided",
    })
    .refine((data: any) => Boolean(data.fileId) || Boolean(data.files?.length), {
      message: "Either fileId or files must be provided",
    }),
  output: z
    .object({
      set: z.literal(true),
      files: z.array(z.object({ name: z.string(), mimeType: z.string(), size: z.number().int() })),
    })
    .strict(),
};

export const screenshotsVisible: ToolDefinition = {
  name: "screenshots.visible",
  title: "Capture visible tab",
  description:
    "Capture the visible area of a tab. Chrome only permits capturing the active tab of a window; background or non-active tabs are rejected. Consistent capture rule: visible, element, fullPage and browser.captureTab all require approval; only viewport dimensions do not.",
  category: "screenshots",
  risk: "sensitive-read",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, format: z.enum(["png", "jpeg"]).default("png"), quality: z.number().int().min(1).max(100).default(80) }).strict(),
  output: z.object({ dataUrl: z.string(), format: z.string(), width: z.number(), height: z.number() }).strict(),
};

export const screenshotsElement: ToolDefinition = {
  name: "screenshots.element",
  title: "Capture element",
  description: "Capture the visible tab and crop the rectangle of a previously found element.",
  category: "screenshots",
  risk: "sensitive-read",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, ref: z.string().min(1).max(128) }).strict(),
  output: z.object({ dataUrl: z.string(), width: z.number(), height: z.number() }).strict(),
};

export const screenshotsViewport: ToolDefinition = {
  name: "screenshots.viewport",
  title: "Get viewport size",
  description: "Return the viewport dimensions and device pixel ratio of a tab.",
  category: "screenshots",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef }).strict(),
  output: z.object({ width: z.number(), height: z.number(), devicePixelRatio: z.number(), scrollY: z.number() }).strict(),
};

export const screenshotsFullPage: ToolDefinition = {
  name: "screenshots.fullPage",
  title: "Capture full page",
  description:
    "Capture the whole scrollable page by scrolling, capturing and stitching the viewport. The page scroll position is restored afterwards. Approval rule, consistent across all capture tools: screenshots.visible, screenshots.element, screenshots.fullPage and browser.captureTab all require approval, because each returns page pixels; only screenshots.viewport (dimensions, no pixels) does not. Policy-by-risk is a second gate, not a replacement.",
  category: "screenshots",
  risk: "sensitive-read",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      maxHeight: z.number().int().min(1000).max(30_000).default(12_000).describe("Maximum captured height in CSS pixels"),
      format: z.enum(["png", "jpeg"]).default("png"),
      quality: z.number().int().min(1).max(100).default(80),
    })
    .strict(),
  output: z.object({ dataUrl: z.string(), format: z.string(), width: z.number(), height: z.number(), pages: z.number().int(), partial: z.boolean().optional(), partialReason: z.string().optional() }).strict(),
};

export const interactTools: ToolDefinition[] = [
  domFind,
  domRead,
  domClick,
  domFocus,
  domHover,
  domScroll,
  domScrollTo,
  domSelect,
  domSetChecked,
  domSetRadio,
  domFill,
  domType,
  domPress,
  domClickAt,
  domMoveTo,
  domDrag,
  domDragAt,
  domBoundingBox,
  domVisible,
  domClear,
  domSubmit,
  domWaitFor,
  domShadow,
  formsInspect,
  formsFill,
  formsSubmit,
  formsPreview,
  formsUpload,
  formsSetFile,
  screenshotsVisible,
  screenshotsElement,
  screenshotsViewport,
  screenshotsFullPage,
];
