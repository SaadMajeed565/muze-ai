import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { PageMetadata, frameIdSchema, tabIdSchema, urlSchema } from "./common.js";

const tabRef = { tabId: tabIdSchema.optional().describe("Defaults to the active tab"), frameId: frameIdSchema.optional() };

export const workflowsSummarizePage: ToolDefinition = {
  name: "workflows.summarizePage",
  title: "Gather page brief",
  description:
    "Collect the metadata and bounded text needed to summarize the active page. Summarization itself is performed by the connected AI client; this workflow never calls a model itself.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, maxChars: z.number().int().min(500).max(50_000).default(12_000) }).strict(),
  output: z
    .object({
      metadata: PageMetadata,
      text: z.string(),
      truncated: z.boolean(),
      note: z.string(),
    })
    .strict(),
};

export const workflowsCompareTabs: ToolDefinition = {
  name: "workflows.compareTabs",
  title: "Compare tabs",
  description: "Collect a bounded excerpt from several tabs so a client can compare them.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  input: z.object({ tabIds: z.array(tabIdSchema).min(2).max(10), maxCharsPerTab: z.number().int().min(200).max(20_000).default(4000) }).strict(),
  output: z
    .object({
      pages: z.array(z.object({ tabId: tabIdSchema, title: z.string(), url: z.string(), excerpt: z.string() })),
      errors: z.array(z.object({ tabId: tabIdSchema, error: z.string() })).optional(),
    })
    .strict(),
};

export const workflowsExtractTable: ToolDefinition = {
  name: "workflows.extractTable",
  title: "Extract table",
  description: "Convenience wrapper around page.tables that returns a single table by index.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z.object({ ...tabRef, index: z.number().int().min(0).default(0), tableIndex: z.number().int().min(0).optional(), maxRows: z.number().int().min(1).max(500).default(200) }).strict(),
  output: z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())), truncated: z.boolean(), totalTables: z.number().int() }).strict(),
};

export const workflowsCollectLinks: ToolDefinition = {
  name: "workflows.collectLinks",
  title: "Collect links across tabs",
  description: "Collect and de-duplicate links from several tabs.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  input: z.object({ tabIds: z.array(tabIdSchema).min(1).max(20), limitPerTab: z.number().int().min(1).max(1000).default(200) }).strict(),
  output: z.object({ links: z.array(z.object({ tabId: tabIdSchema, href: z.string(), text: z.string() })), errors: z.array(z.object({ tabId: tabIdSchema, error: z.string() })).optional() }).strict(),
};

export const workflowsOpenSequence: ToolDefinition = {
  name: "workflows.openSequence",
  title: "Open URL sequence",
  description: "Open an approved list of URLs, one tab per URL, with an optional delay. Requires fresh approval.",
  category: "workflows",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ urls: z.array(urlSchema).min(1).max(20), delayMs: z.number().int().min(0).max(10_000).default(500), active: z.boolean().default(false) }).strict(),
  output: z.object({ opened: z.array(z.object({ url: z.string(), tabId: tabIdSchema })), partial: z.boolean().optional(), error: z.string().optional() }).strict(),
};

export const workflowsFillFormForReview: ToolDefinition = {
  name: "workflows.fillFormForReview",
  title: "Fill form for review",
  description: "Fill form fields and stop so the user can review before anything is submitted. Never submits.",
  category: "workflows",
  risk: "reversible",
  requiresApproval: false,
  targetsActiveTab: true,
  input: z
    .object({
      ...tabRef,
      formRef: z.string().min(1).max(128),
      fields: z.array(z.object({ ref: z.string().min(1).max(128), value: z.string().max(10_000) })).min(1).max(100),
    })
    .strict(),
  output: z.object({ formRef: z.string(), filled: z.number().int(), skipped: z.number().int(), awaitingReview: z.literal(true) }).strict(),
};

export const workflowsOrganizeTabs: ToolDefinition = {
  name: "workflows.organizeTabs",
  title: "Organize tabs by topic",
  description: "Group open tabs by registrable domain or title prefix. Requires fresh approval because it restructures the user's tabs.",
  category: "workflows",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ strategy: z.enum(["domain", "titlePrefix"]).default("domain"), windowId: z.number().int().optional(), maxGroups: z.number().int().min(1).max(20).default(8) }).strict(),
  output: z.object({ groups: z.array(z.object({ title: z.string(), tabIds: z.array(tabIdSchema) })), ungrouped: z.array(tabIdSchema).optional(), skipped: z.number().int().optional() }).strict(),
};

export const workflowsSaveSession: ToolDefinition = {
  name: "workflows.saveSession",
  title: "Save tab session",
  description: "Save the URLs and titles of open tabs as a named session. Requires fresh approval.",
  category: "workflows",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ name: z.string().min(1).max(120), windowId: z.number().int().optional() }).strict(),
  output: z.object({ sessionId: z.string(), name: z.string(), tabCount: z.number().int(), skipped: z.number().int().optional() }).strict(),
};

export const workflowsRestoreSession: ToolDefinition = {
  name: "workflows.restoreSession",
  title: "Restore tab session",
  description: "Open all tabs saved in a session. Requires fresh approval.",
  category: "workflows",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ sessionId: z.string(), active: z.boolean().default(false) }).strict(),
  output: z.object({ restored: z.number().int(), tabIds: z.array(tabIdSchema), partial: z.boolean().optional(), error: z.string().optional(), skipped: z.array(z.string()).optional() }).strict(),
};

export const workflowsResearchReport: ToolDefinition = {
  name: "workflows.researchReport",
  title: "Gather research material",
  description:
    "Collect bounded sections (metadata, headings, text) from selected pages so a client can write a structured report. The extension does not generate prose or call a model.",
  category: "workflows",
  risk: "read-only",
  requiresApproval: false,
  input: z.object({ tabIds: z.array(tabIdSchema).min(1).max(20), maxCharsPerTab: z.number().int().min(500).max(20_000).default(6000) }).strict(),
  output: z
    .object({
      sections: z.array(
        z.object({ tabId: tabIdSchema, title: z.string(), url: z.string(), headings: z.array(z.string()), text: z.string() }),
      ),
      errors: z.array(z.object({ tabId: tabIdSchema, error: z.string() })).optional(),
    })
    .strict(),
};

export const workflowTools: ToolDefinition[] = [
  workflowsSummarizePage,
  workflowsCompareTabs,
  workflowsExtractTable,
  workflowsCollectLinks,
  workflowsOpenSequence,
  workflowsFillFormForReview,
  workflowsOrganizeTabs,
  workflowsSaveSession,
  workflowsRestoreSession,
  workflowsResearchReport,
];
