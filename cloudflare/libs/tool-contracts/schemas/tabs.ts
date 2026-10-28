import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { EmptyInput, TabInfo, WindowInfo, tabIdSchema, urlSchema, windowIdSchema } from "./common.js";

export const tabsList: ToolDefinition = {
  name: "tabs.list",
  title: "List tabs",
  description: "List open tabs and their basic metadata. Does not return cookies or credentials.",
  category: "tabs",
  risk: "read-only",
  requiresApproval: false,
  input: z.object({ windowId: windowIdSchema.optional(), currentWindowOnly: z.boolean().default(false) }).strict(),
  output: z.object({ tabs: z.array(TabInfo) }).strict(),
};

export const tabsActive: ToolDefinition = {
  name: "tabs.active",
  title: "Get active tab",
  description: "Return the currently active tab in the last focused window.",
  category: "tabs",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z.object({ tab: TabInfo.nullable() }).strict(),
};

export const tabsGet: ToolDefinition = {
  name: "tabs.get",
  title: "Get tab details",
  description: "Return metadata for a single tab id, including title, URL, loading status and window id.",
  category: "tabs",
  risk: "read-only",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema }).strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const tabsSearch: ToolDefinition = {
  name: "tabs.search",
  title: "Search tabs",
  description:
    "Search open tabs by title and/or URL substring (case-insensitive). When no query is given, Chrome's own filters apply.",
  category: "tabs",
  risk: "read-only",
  requiresApproval: false,
  input: z
    .object({
      query: z.string().min(1).max(256).optional(),
      match: z.enum(["title", "url", "both"]).default("both"),
      limit: z.number().int().min(1).max(200).default(50),
      windowId: windowIdSchema.optional(),
      currentWindowOnly: z.boolean().default(false),
      pinned: z.boolean().optional(),
      audible: z.boolean().optional(),
      discarded: z.boolean().optional(),
      url: z.string().max(2048).optional().describe("Chrome match pattern, for example https://example.com/*"),
      title: z.string().max(256).optional().describe("Chrome title match pattern, for example *Invoice*"),
    })
    .strict(),
  output: z.object({ tabs: z.array(TabInfo) }).strict(),
};

export const tabsCreate: ToolDefinition = {
  name: "tabs.create",
  title: "Create tab",
  description:
    "Open a new tab. Only http/https and about:blank URLs are permitted. The tab can be pinned, placed in a group or opened as a child of another tab.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z
    .object({
      url: urlSchema.optional(),
      active: z.boolean().default(true),
      windowId: windowIdSchema.optional(),
      groupId: z.number().int().optional().describe("Tab group to open the tab in"),
      pinned: z.boolean().default(false),
      openerTabId: tabIdSchema.optional().describe("Open as a child of this tab"),
      index: z.number().int().min(0).optional().describe("Position within the window"),
    })
    .strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const tabsNavigate: ToolDefinition = {
  name: "tabs.navigate",
  title: "Navigate tab",
  description: "Navigate an existing tab to a new http/https URL.",
  category: "navigation",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema, url: urlSchema }).strict(),
  output: z.object({ tab: TabInfo, navigationId: z.string().nullable() }).strict(),
};

export const tabsReload: ToolDefinition = {
  name: "tabs.reload",
  title: "Reload tab",
  description: "Reload a tab, optionally bypassing the HTTP cache.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema, bypassCache: z.boolean().default(false) }).strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const tabsDuplicate: ToolDefinition = {
  name: "tabs.duplicate",
  title: "Duplicate tab",
  description: "Duplicate an existing tab.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema }).strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const tabsActivate: ToolDefinition = {
  name: "tabs.activate",
  title: "Activate tab",
  description: "Make a tab active and focus its window.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema }).strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const tabsClose: ToolDefinition = {
  name: "tabs.close",
  title: "Close tab",
  description: "Close a tab. Closing the last tab of a window closes the window.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema }).strict(),
  output: z.object({ closed: z.literal(true), tabId: tabIdSchema }).strict(),
};

export const tabsGroup: ToolDefinition = {
  name: "tabs.group",
  title: "Group tabs",
  description: "Group the given tabs, optionally setting a title and color.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z
    .object({
      tabIds: z.array(tabIdSchema).min(1).max(50),
      groupId: z.number().int().optional(),
      title: z.string().max(120).optional(),
      color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional(),
    })
    .strict(),
  output: z.object({ groupId: z.number().int() }).strict(),
};

export const tabsMove: ToolDefinition = {
  name: "tabs.move",
  title: "Move tabs",
  description: "Move one or more tabs to another window at an optional index.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabIds: z.array(tabIdSchema).min(1).max(50), windowId: windowIdSchema.optional().describe("Omit to move within the current window"), index: z.number().int().min(-1).optional() }).strict(),
  output: z.object({ moved: z.array(tabIdSchema) }).strict(),
};

export const tabsPin: ToolDefinition = {
  name: "tabs.pin",
  title: "Pin/unpin tab",
  description: "Pin or unpin a tab.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema, pinned: z.boolean() }).strict(),
  output: z.object({ tab: TabInfo }).strict(),
};

export const windowsList: ToolDefinition = {
  name: "windows.list",
  title: "List windows",
  description: "List browser windows and their state.",
  category: "windows",
  risk: "read-only",
  requiresApproval: false,
  input: EmptyInput,
  output: z.object({ windows: z.array(WindowInfo) }).strict(),
};

export const windowsCreate: ToolDefinition = {
  name: "windows.create",
  title: "Create window",
  description: "Create a new browser window, optionally opening a URL. Creating an incognito window requires a reversible-or-higher policy allowance; it is not granted silently by this contract.",
  category: "windows",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ url: urlSchema.optional(), focused: z.boolean().default(true), incognito: z.boolean().default(false).describe("Requires a reversible-or-higher policy allowance; never granted silently") }).strict(),
  output: z.object({ window: WindowInfo }).strict(),
};

export const windowsUpdate: ToolDefinition = {
  name: "windows.update",
  title: "Update window",
  description: "Minimize, maximize, restore or focus a window, optionally resizing and moving it.",
  category: "windows",
  risk: "reversible",
  requiresApproval: false,
  input: z
    .object({
      windowId: windowIdSchema,
      state: z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional(),
      focused: z.boolean().optional(),
      width: z.number().int().min(200).max(10_000).optional(),
      height: z.number().int().min(200).max(10_000).optional(),
      left: z.number().int().min(-10_000).max(10_000).optional(),
      top: z.number().int().min(-10_000).max(10_000).optional(),
    })
    .strict(),
  output: z.object({ window: WindowInfo }).strict(),
};

export const windowsClose: ToolDefinition = {
  name: "windows.close",
  title: "Close window",
  description: "Close a browser window and every tab inside it.",
  category: "windows",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ windowId: windowIdSchema }).strict(),
  output: z.object({ closed: z.literal(true), windowId: windowIdSchema }).strict(),
};

export const tabsUngroup: ToolDefinition = {
  name: "tabs.ungroup",
  title: "Ungroup tabs",
  description: "Remove tabs from their tab group. The tabs themselves stay open.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabIds: z.array(tabIdSchema).min(1).max(50) }).strict(),
  output: z.object({ ungrouped: z.array(tabIdSchema) }).strict(),
};

export const tabsMute: ToolDefinition = {
  name: "tabs.mute",
  title: "Mute or unmute tab",
  description: "Mute or unmute the audio playing in a tab.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema, muted: z.boolean() }).strict(),
  output: z.object({ tabId: tabIdSchema, muted: z.boolean() }).strict(),
};

export const tabsSetZoom: ToolDefinition = {
  name: "tabs.setZoom",
  title: "Set tab zoom",
  description: "Set the zoom level of a tab. 100% is the default scale.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema, zoom: z.number().min(0.25).max(5) }).strict(),
  output: z.object({ tabId: tabIdSchema, zoom: z.number() }).strict(),
};

export const tabsDiscard: ToolDefinition = {
  name: "tabs.discard",
  title: "Discard tab",
  description:
    "Discard a tab to free its memory. The tab is unloaded and reloads when it is activated again; unsaved page state is lost.",
  category: "tabs",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ tabId: tabIdSchema }).strict(),
  output: z.object({ discarded: z.literal(true), tabId: tabIdSchema }).strict(),
};

export const tabsTools: ToolDefinition[] = [
  tabsList,
  tabsActive,
  tabsGet,
  tabsSearch,
  tabsCreate,
  tabsNavigate,
  tabsReload,
  tabsDuplicate,
  tabsActivate,
  tabsClose,
  tabsGroup,
  tabsUngroup,
  tabsMove,
  tabsPin,
  tabsMute,
  tabsSetZoom,
  tabsDiscard,
  windowsList,
  windowsCreate,
  windowsUpdate,
  windowsClose,
];
