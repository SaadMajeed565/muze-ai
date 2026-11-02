import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { EmptyInput, TabInfo, tabIdSchema, tabRef, urlSchema } from "./common.js";


export const downloadsList: ToolDefinition = {
  name: "downloads.list",
  title: "List downloads",
  description: "List recent downloads and their metadata. Requires the optional downloads permission group.",
  category: "downloads",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z.object({ limit: z.number().int().min(1).max(500).default(50), query: z.string().max(256).optional() }).strict(),
  output: z
    .object({
      downloads: z.array(
        z.object({
          id: z.number().int(),
          filename: z.string(),
          url: z.string(),
          state: z.enum(["in_progress", "interrupted", "complete", "unknown"]),
          bytesReceived: z.number(),
          totalBytes: z.number().optional(),
          paused: z.boolean(),
          startTime: z.string(),
          error: z.string().optional(),
        }),
      ),
    })
    .strict(),
};

export const downloadsControl: ToolDefinition = {
  name: "downloads.control",
  title: "Control download",
  description: "Pause, resume or cancel a download by id.",
  category: "downloads",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ id: z.number().int(), action: z.enum(["pause", "resume", "cancel"]) }).strict(),
  output: z.object({ id: z.number().int(), action: z.string(), ok: z.literal(true) }).strict(),
};

export const downloadsStart: ToolDefinition = {
  name: "downloads.start",
  title: "Start download",
  description:
    "Download a file from an approved http/https URL. The file is saved in the browser's download folder unless a directory is given. Requires fresh user approval. Schema length caps only (filename/directory, 255 chars each); path containment and traversal rejection are enforced downstream by the downloads handler, not by this schema.",
  category: "downloads",
  risk: "consequential",
  requiresApproval: true,
  input: z
    .object({
      url: urlSchema,
      filename: z.string().max(255).optional(),
      directory: z.string().max(255).optional(),
      saveAs: z.boolean().default(false),
      conflictAction: z.enum(["uniquify", "overwrite", "prompt"]).default("uniquify"),
    })
    .strict(),
  output: z.object({ id: z.number().int(), filename: z.string() }).strict(),
};

export const downloadsErase: ToolDefinition = {
  name: "downloads.erase",
  title: "Erase download history",
  description: "Remove download entries from the browser's download history. Requires fresh user approval.",
  category: "downloads",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ ids: z.array(z.number().int()).min(1).max(100) }).strict(),
  output: z.object({ erased: z.number().int() }).strict(),
};

export const clipboardRead: ToolDefinition = {
  name: "clipboard.read",
  title: "Read clipboard",
  description: "Read the system clipboard text. Requires explicit, single-use approval. Never runs silently. The unified clipboard tool matches this approval:true behaviour; policy-by-risk is a second gate, not a replacement.",
  category: "clipboard",
  risk: "sensitive-read",
  requiresApproval: true,
  input: z.object({}).strict(),
  output: z.object({ text: z.string(), truncated: z.boolean() }).strict(),
};

export const clipboardWrite: ToolDefinition = {
  name: "clipboard.write",
  title: "Write clipboard",
  description: "Write approved text to the system clipboard. Requires fresh user approval. The unified clipboard tool matches this approval:true behaviour; policy-by-risk is a second gate, not a replacement.",
  category: "clipboard",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ text: z.string().max(100_000) }).strict(),
  output: z.object({ written: z.literal(true), chars: z.number().int() }).strict(),
};

export const browserInfo: ToolDefinition = {
  name: "browser.info",
  title: "Browser and extension info",
  description: "Return browser, extension and protocol versions. Contains no secrets.",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z
    .object({
      extensionVersion: z.string(),
      protocolVersion: z.string(),
      registryVersion: z.string(),
      userAgent: z.string(),
      platform: z.string(),
      browserVersion: z.string().optional(),
      locale: z.string().optional(),
      timeZone: z.string().optional(),
      manifestVersion: z.number().int().optional(),
    })
    .strict(),
};

export const browserCapabilities: ToolDefinition = {
  name: "browser.capabilities",
  title: "List capabilities",
  description:
    "Return the tool categories, optional permission groups, the browser capabilities that are available right now and the enabled features.",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z
    .object({
      toolCount: z.number().int(),
      categories: z.array(z.string()),
      optionalGroups: z.record(z.string(), z.boolean()),
      readOnlyMode: z.boolean(),
      killSwitch: z.boolean(),
      capabilities: z.array(z.string()),
      mode: z.string().optional(),
    })
    .strict(),
};

export const browserPermissions: ToolDefinition = {
  name: "browser.permissions",
  title: "Report tool permissions",
  description: "Report which tools and categories are currently allowed for the calling client.",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z.object({ allowedTools: z.array(z.string()), deniedTools: z.array(z.string()), readOnlyMode: z.boolean() }).strict(),
};

export const browserActiveContext: ToolDefinition = {
  name: "browser.activeContext",
  title: "Active page context",
  description: "Return lightweight metadata about the active tab and whether it is a restricted page.",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z.object({ tab: TabInfo.nullable(), restricted: z.boolean() }).strict(),
};

export const browserDiagnostics: ToolDefinition = {
  name: "browser.diagnostics",
  title: "Diagnostics",
  description: "Return bridge status, connected client count, pending approvals and recent audit summary. No sensitive content.",
  category: "browser",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z
    .object({
      bridgeStatus: z.enum(["connected", "disconnected"]),
      connectedClients: z.number().int(),
      pendingApprovals: z.number().int(),
      killSwitch: z.boolean(),
      auditEvents: z.number().int(),
    })
    .strict(),
};

export const browserObserver: ToolDefinition = {
  name: "browser.observer",
  title: "Enable or disable the page observer",
  description:
    "Turn the page observer on or off for a tab. Defaults to the active tab. The observer records JavaScript dialogs, request metadata, console output and page errors. It never records request or response bodies.",
  category: "browser",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ enabled: z.boolean(), tabId: tabIdSchema.optional() }).strict(),
  output: z.object({ enabled: z.boolean(), tabs: z.number().int() }).strict(),
};

export const browserSearch: ToolDefinition = {
  name: "browser.search",
  title: "Search browsing data",
  description:
    "Search the browser's history, bookmarks and open tabs in one call. Each source can be switched off. Chrome does not expose omnibox suggestions to extensions, so those are not included.",
  category: "browser",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z
    .object({
      query: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(100).default(20),
      includeHistory: z.boolean().default(true),
      includeBookmarks: z.boolean().default(true),
      includeTabs: z.boolean().default(true),
    })
    .strict(),
  output: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          source: z.enum(["history", "bookmark", "tab"]),
          visitCount: z.number().int().optional(),
          lastVisitTime: z.string().optional(),
        }),
      ),
      errors: z.array(z.object({ source: z.enum(["history", "bookmark", "tab"]), error: z.string() })).optional(),
    })
    .strict(),
};

export const browserCaptureTab: ToolDefinition = {
  name: "browser.captureTab",
  title: "Capture the active tab",
  description:
    "Capture a still image of the active tab of a window. Only the visible area is captured, and only for the active tab of a window. Consistent capture rule: browser.captureTab requires approval, exactly like screenshots.visible/element/fullPage/viewport; policy-by-risk is a second gate, not a replacement.",
  category: "browser",
  risk: "sensitive-read",
  requiresApproval: true,
  input: z.object({ windowId: z.number().int().optional(), format: z.enum(["png", "jpeg"]).default("png"), quality: z.number().int().min(1).max(100).default(80) }).strict(),
  output: z.object({ dataUrl: z.string(), format: z.string(), width: z.number(), height: z.number() }).strict(),
};

export const devtoolsNetwork: ToolDefinition = {
  name: "devtools.network",
  title: "Observed requests",
  description:
    "Return the requests the observer saw on the page. Only method, URL, status and timing are recorded; request and response bodies are never captured.",
  category: "devtools",
  risk: "sensitive-read",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      limit: z.number().int().min(1).max(500).default(100),
      urlFilter: z.string().max(512).optional(),
      onlyFailed: z.boolean().default(false),
    })
    .strict(),
  output: z
    .object({
      requests: z.array(
        z.object({
          id: z.string(),
          method: z.string(),
          url: z.string(),
          status: z.number().int().optional(),
          type: z.string().optional(),
          startedAt: z.string(),
          durationMs: z.number().int().optional(),
          failed: z.boolean().optional(),
        }),
      ),
      attached: z.boolean(),
    })
    .strict(),
};

export const devtoolsDom: ToolDefinition = {
  name: "devtools.dom",
  title: "Inspect DOM structure",
  description: "Return a bounded, read-only outline of the DOM (tags, ids, classes) for the active page.",
  category: "devtools",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, maxNodes: z.number().int().min(1).max(2000).default(300), maxDepth: z.number().int().min(1).max(20).default(8) }).strict(),
  output: z.object({ nodes: z.array(z.object({ depth: z.number().int(), tag: z.string(), id: z.string().optional(), classes: z.array(z.string()) })) }).strict(),
};

export const devtoolsPerformance: ToolDefinition = {
  name: "devtools.performance",
  title: "Page performance timing",
  description: "Return navigation timing and paint metrics exposed by the page.",
  category: "devtools",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef }).strict(),
  output: z
    .object({
      navigation: z.record(z.string(), z.number()),
      paint: z.record(z.string(), z.number()),
      resources: z.number().int(),
    })
    .strict(),
};

export const devtoolsPageErrors: ToolDefinition = {
  name: "devtools.pageErrors",
  title: "Page error summary",
  description: "Return recent uncaught errors captured on the page while the extension content script was attached.",
  category: "devtools",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: z.object({ errors: z.array(z.object({ message: z.string(), source: z.string().optional(), at: z.string() })) }).strict(),
};

export const devtoolsConsole: ToolDefinition = {
  name: "devtools.console",
  title: "Console messages",
  description:
    "Return console messages captured after the extension was attached. Only messages that occurred while attached are available; historical console output is not accessible.",
  category: "devtools",
  risk: "sensitive-read",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, limit: z.number().int().min(1).max(500).default(100), level: z.enum(["all", "error", "warn", "info", "log"]).default("all") }).strict(),
  output: z.object({ messages: z.array(z.object({ level: z.string(), text: z.string(), at: z.string() })) }).strict(),
};

export const systemTools: ToolDefinition[] = [
  downloadsList,
  downloadsControl,
  downloadsStart,
  downloadsErase,
  clipboardRead,
  clipboardWrite,
  browserInfo,
  browserCapabilities,
  browserPermissions,
  browserActiveContext,
  browserDiagnostics,
  browserObserver,
  browserSearch,
  browserCaptureTab,
  devtoolsDom,
  devtoolsPerformance,
  devtoolsPageErrors,
  devtoolsConsole,
  devtoolsNetwork,
];
