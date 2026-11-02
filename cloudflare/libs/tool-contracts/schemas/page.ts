import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { BoundedText, PageMetadata, TabInfo, tabIdSchema, tabRef, urlSchema } from "./common.js";


export const pageRead: ToolDefinition = {
  name: "page.read",
  title: "Read page text",
  description:
    "Extract the visible text of a page in bounded chunks. Content is only requested for a specific tool call; it is never uploaded automatically.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().min(200).max(100_000).default(20_000),
    })
    .strict(),
  output: BoundedText,
};

export const pageMetadata: ToolDefinition = {
  name: "page.metadata",
  title: "Get page metadata",
  description: "Return the title, canonical URL, description, headings and meta tags of a page.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef }).strict(),
  output: PageMetadata,
};

export const pageOutline: ToolDefinition = {
  name: "page.outline",
  title: "Get page outline",
  description: "Return a simplified outline of the page using heading structure.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, maxDepth: z.number().int().min(1).max(6).default(3) }).strict(),
  output: z.object({ outline: z.array(z.object({ level: z.number().int(), text: z.string() })) }).strict(),
};

export const pageLinks: ToolDefinition = {
  name: "page.links",
  title: "Collect page links",
  description: "Return links found on a page, with their visible text, resolved href, target and download attribute.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({ ...tabRef, limit: z.number().int().min(1).max(1000).default(200), sameOriginOnly: z.boolean().default(false) })
    .strict(),
  output: z
    .object({
      links: z.array(
        z.object({
          text: z.string(),
          href: z.string(),
          rel: z.string().optional(),
          target: z.string().optional(),
          download: z.string().optional(),
          internal: z.boolean(),
        }),
      ),
    })
    .strict(),
};

export const pageSelectedText: ToolDefinition = {
  name: "page.selectedText",
  title: "Get selected text",
  description: "Return the text currently selected by the user on the page.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef }).strict(),
  output: z.object({ text: z.string() }).strict(),
};

export const pageFind: ToolDefinition = {
  name: "page.find",
  title: "Find text on page",
  description: "Search for text on the page and return matches with context.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      query: z.string().min(1).max(500),
      caseSensitive: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
      contextChars: z.number().int().min(0).max(500).default(80),
    })
    .strict(),
  output: z.object({
    matches: z.array(z.object({ index: z.number(), text: z.string(), context: z.string().optional() })),
    total: z.number().int(),
  }),
};

export const pageExtract: ToolDefinition = {
  name: "page.extract",
  title: "Extract structured data",
  description:
    "Extract text/attributes from elements matching selectors. Credential fields (password, hidden, card or token named) are replaced with a placeholder and never read.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      fields: z.array(
        z.object({ name: z.string().min(1).max(64), selector: z.string().min(1).max(512), attribute: z.string().max(64).optional() }),
      ).min(1).max(100),
    })
    .strict(),
  output: z
    .object({
      results: z.record(z.string(), z.string()),
      elements: z
        .record(
          z.string(),
          z
            .object({
              tagName: z.string().optional(),
              type: z.string().optional(),
              name: z.string().optional(),
              id: z.string().optional(),
              autocomplete: z.string().optional(),
              ariaLabel: z.string().optional(),
              metaName: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
};

export const pageWaitFor: ToolDefinition = {
  name: "page.waitFor",
  title: "Wait for element",
  description:
    "Wait for an element to appear. A CSS selector can be given directly, or a strategy such as text, role, name, label or placeholder can be used instead.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      selector: z.string().min(1).max(512).optional().describe("CSS selector to wait for"),
      by: z.enum(["selector", "text", "label", "placeholder", "role", "name"]).default("selector"),
      value: z.string().min(1).max(512).optional().describe("Value for the chosen strategy"),
      role: z.string().max(64).optional(),
      name: z.string().max(256).optional(),
      timeoutMs: z.number().int().min(500).max(120_000).default(10_000),
    })
    .strict(),
  output: z.object({ found: z.boolean(), ref: z.string().nullable(), timedOut: z.boolean() }).strict(),
};

export const pageTables: ToolDefinition = {
  name: "page.tables",
  title: "Extract tables",
  description: "Extract structured tables as arrays of rows. Large tables are truncated to bounded cell counts.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({ ...tabRef, index: z.number().int().min(0).optional(), maxRows: z.number().int().min(1).max(500).default(100) })
    .strict(),
  output: z
    .object({
      tables: z.array(z.object({ index: z.number().int(), headers: z.array(z.string()), rows: z.array(z.array(z.string())), truncated: z.boolean() })),
    })
    .strict(),
};

export const pageNetworkIdle: ToolDefinition = {
  name: "page.networkIdle",
  title: "Wait for network idle",
  description:
    "Wait until the page stops loading resources. Uses the observer's in-flight request counter when the observer is attached, and the page's resource timeline otherwise.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      quietMs: z.number().int().min(100).max(30_000).default(500).describe("Time without new activity that counts as idle"),
      timeoutMs: z.number().int().min(500).max(120_000).default(15_000),
    })
    .strict(),
  output: z.object({ idle: z.boolean(), pending: z.number().int(), waitedMs: z.number().int(), timedOut: z.boolean() }).strict(),
};

export const pageAccessibilityTree: ToolDefinition = {
  name: "page.accessibilityTree",
  title: "Accessibility tree",
  description:
    "Return an accessibility tree built from the DOM, including the accessible name and role of each node. Chrome's native AX tree requires the debugger, which Muze never attaches.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      maxNodes: z.number().int().min(1).max(2000).default(300),
      maxDepth: z.number().int().min(1).max(20).default(10),
      interactiveOnly: z.boolean().default(true).describe("Only return elements a user can operate"),
    })
    .strict(),
  output: z
    .object({
      nodes: z.array(
        z.object({
          ref: z.string(),
          role: z.string(),
          name: z.string(),
          value: z.string().optional(),
          description: z.string().optional(),
          checked: z.boolean().optional(),
          disabled: z.boolean().optional(),
          focused: z.boolean().optional(),
          level: z.number().int().optional(),
          children: z.number().int(),
          viewportX: z.number().optional(),
          viewportY: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
        }),
      ),
    })
    .strict(),
};

export const pageSnapshot: ToolDefinition = {
  name: "page.snapshot",
  title: "Snapshot page",
  description:
    "One observe step: interactive accessibility nodes with CSS-viewport bounding boxes, plus viewport metrics. Set includeScreenshot=true to also return a JPEG of the visible viewport in the same call. Node boxes use CSS pixels with dom.clickAt; screenshot pixels are device pixels (set coordinateSpace=screenshot).",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      maxNodes: z.number().int().min(1).max(2000).default(200),
      maxDepth: z.number().int().min(1).max(20).default(8),
      includeScreenshot: z.boolean().default(false).describe("Include a screenshot of the visible viewport in this call"),
      screenshotFormat: z.enum(["jpeg", "png"]).default("jpeg"),
      screenshotQuality: z.number().int().min(1).max(100).default(60),
    })
    .strict(),
  output: z
    .object({
      nodes: z.array(
        z.object({
          ref: z.string(),
          role: z.string(),
          name: z.string(),
          value: z.string().optional(),
          description: z.string().optional(),
          checked: z.boolean().optional(),
          disabled: z.boolean().optional(),
          focused: z.boolean().optional(),
          level: z.number().int().optional(),
          children: z.number().int(),
          viewportX: z.number().optional(),
          viewportY: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
        }),
      ),
      viewport: z.object({
        width: z.number(),
        height: z.number(),
        devicePixelRatio: z.number(),
        scrollY: z.number(),
      }),
      screenshot: z
        .object({
          dataUrl: z.string(),
          format: z.string(),
          width: z.number(),
          height: z.number(),
        })
        .optional(),
      coordinateHint: z.string(),
    })
    .strict(),
};


export const pageDialogs: ToolDefinition = {
  name: "page.dialogs",
  title: "List page dialogs",
  description:
    "List the JavaScript dialogs the page opened. The observer answers them automatically with the tab's default answer, so the page is never blocked. Requires the page observer to be attached.",
  category: "page",
  risk: "sensitive-read",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, limit: z.number().int().min(1).max(100).default(20) }).strict(),
  output: z
    .object({
      dialogs: z.array(
        z.object({
          id: z.string(),
          type: z.enum(["alert", "confirm", "prompt"]),
          message: z.string(),
          defaultValue: z.string().optional(),
          at: z.string(),
          answered: z.enum(["accept", "dismiss"]),
        }),
      ),
      defaultAnswer: z.enum(["accept", "dismiss"]).describe("The answer this tab now uses for new dialogs"),
      attached: z.boolean().describe("Whether the observer is running on this tab"),
    })
    .strict(),
};

export const pageRespondDialog: ToolDefinition = {
  name: "page.respondDialog",
  title: "Set the dialog answer",
  description:
    "Set the answer the observer gives to JavaScript dialogs on this tab. The answer is sticky: it applies to every dialog the page opens from now on.",
  category: "page",
  risk: "consequential",
  requiresApproval: true,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      response: z.enum(["accept", "dismiss"]).default("dismiss"),
      text: z.string().max(2000).optional().describe("Text returned for a prompt dialog"),
    })
    .strict(),
  output: z.object({ applied: z.literal(true), response: z.enum(["accept", "dismiss"]), text: z.string().optional() }).strict(),
};

export const navigationOpen: ToolDefinition = {
  name: "navigation.open",
  title: "Open URL",
  description: "Open an http/https URL. Reuses the active tab when reuseActiveTab is true, otherwise opens a new tab.",
  category: "navigation",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ url: urlSchema, reuseActiveTab: z.boolean().default(false), active: z.boolean().default(true) }).strict(),
  output: z.object({ tab: TabInfo, navigationId: z.string().nullable() }).strict(),
};

export const navigationBack: ToolDefinition = {
  name: "navigation.back",
  title: "Navigate back",
  description: "Go back in a tab's history.",
  category: "navigation",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ tabId: tabIdSchema.optional() }).strict(),
  output: z.object({ tab: TabInfo, navigationId: z.string().nullable() }).strict(),
};

export const navigationForward: ToolDefinition = {
  name: "navigation.forward",
  title: "Navigate forward",
  description: "Go forward in a tab's history.",
  category: "navigation",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ tabId: tabIdSchema.optional() }).strict(),
  output: z.object({ tab: TabInfo, navigationId: z.string().nullable() }).strict(),
};

export const navigationReload: ToolDefinition = {
  name: "navigation.reload",
  title: "Reload page",
  description: "Reload a tab.",
  category: "navigation",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ tabId: tabIdSchema.optional(), bypassCache: z.boolean().default(false) }).strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const navigationSearch: ToolDefinition = {
  name: "navigation.search",
  title: "Web search",
  description:
    "Run a web search through a documented provider (default: the DuckDuckGo HTML endpoint, which needs no scripts). Returns the search URL and the resulting tab.",
  category: "navigation",
  risk: "reversible",
  requiresApproval: false,
  input: z
    .object({
      query: z.string().min(1).max(512),
      provider: z.enum(["duckduckgo", "bing", "google", "wikipedia"]).default("duckduckgo"),
      newTab: z.boolean().default(true),
      waitForLoad: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
    })
    .strict(),
  output: z.object({ searchUrl: z.string(), tab: TabInfo, loaded: z.boolean() }).strict(),
};

export const navigationWait: ToolDefinition = {
  name: "navigation.wait",
  title: "Wait for navigation",
  description:
    "Wait until a tab finishes loading or a timeout elapses. Optionally also waits for the page to become network-idle, which covers single page applications that never fire a load event.",
  category: "navigation",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      tabId: tabIdSchema.optional(),
      timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
      waitForNetworkIdle: z.boolean().default(false),
      quietMs: z.number().int().min(100).max(30_000).default(500),
    })
    .strict(),
  output: z.object({ status: z.enum(["complete", "loading"]), url: z.string(), timedOut: z.boolean(), idle: z.boolean().optional() }).strict(),
};

export const framesList: ToolDefinition = {
  name: "frames.list",
  title: "List frames",
  description:
    "List the top frame and all iframes of a tab with their frame ids, URLs, titles and how they are nested. Use a returned frameId with the frameId argument of other tools to act inside an iframe.",
  category: "page",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ tabId: tabIdSchema.optional() }).strict(),
  output: z
    .object({
      frames: z.array(
        z.object({
          frameId: z.number().int().min(0),
          parentFrameId: z.number().int().min(-1),
          depth: z.number().int().min(0),
          url: z.string(),
          title: z.string().optional(),
          sameOrigin: z.boolean(),
        }),
      ),
    })
    .strict(),
};

export const pageTools: ToolDefinition[] = [
  pageRead,
  pageMetadata,
  pageOutline,
  pageLinks,
  pageSelectedText,
  pageFind,
  pageExtract,
  pageWaitFor,
  pageTables,
  pageNetworkIdle,
  pageAccessibilityTree,
  pageSnapshot,
  pageDialogs,
  pageRespondDialog,
  navigationOpen,
  navigationBack,
  navigationForward,
  navigationReload,
  navigationSearch,
  navigationWait,
  framesList,
];
