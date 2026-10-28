import { z } from "zod";
import type { ToolDefinition } from "../tools.js";
import { urlSchema } from "./common.js";

const BookmarkNode = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  title: z.string(),
  url: z.string().optional(),
  dateAdded: z.string().optional(),
  folder: z.string(),
});

export const bookmarksSearch: ToolDefinition = {
  name: "bookmarks.search",
  title: "Search bookmarks",
  description: "Search bookmarks by title or URL. Disabled unless the bookmarks permission group is enabled.",
  category: "bookmarks",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z.object({ query: z.string().min(1).max(256), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: z.object({ bookmarks: z.array(BookmarkNode) }).strict(),
};

export const bookmarksList: ToolDefinition = {
  name: "bookmarks.list",
  title: "List bookmarks",
  description: "List bookmarks under an optional folder id.",
  category: "bookmarks",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z.object({ folderId: z.string().optional(), limit: z.number().int().min(1).max(2000).default(500) }).strict(),
  output: z.object({ bookmarks: z.array(BookmarkNode), folders: z.array(z.object({ id: z.string(), title: z.string() })) }).strict(),
};

export const bookmarksCreate: ToolDefinition = {
  name: "bookmarks.create",
  title: "Create bookmark",
  description: "Create a bookmark.",
  category: "bookmarks",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ title: z.string().min(1).max(512), url: urlSchema, parentId: z.string().optional() }).strict(),
  output: z.object({ bookmark: BookmarkNode }).strict(),
};

export const bookmarksUpdate: ToolDefinition = {
  name: "bookmarks.update",
  title: "Update bookmark",
  description: "Rename or re-target an existing bookmark.",
  category: "bookmarks",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ id: z.string(), title: z.string().min(1).max(512).optional(), url: urlSchema.optional() }).strict(),
  output: z.object({ bookmark: BookmarkNode }).strict(),
};

export const bookmarksDelete: ToolDefinition = {
  name: "bookmarks.delete",
  title: "Delete bookmark",
  description: "Delete a bookmark. Recoverable from Chrome's bookmark manager only until it is purged.",
  category: "bookmarks",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ deleted: z.literal(true), id: z.string() }).strict(),
};

export const bookmarksMove: ToolDefinition = {
  name: "bookmarks.move",
  title: "Move bookmark",
  description: "Move a bookmark or folder into another folder.",
  category: "bookmarks",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ id: z.string(), parentId: z.string().optional(), index: z.number().int().min(0).optional() }).strict(),
  output: z.object({ bookmark: BookmarkNode }).strict(),
};

export const bookmarksCreateFolder: ToolDefinition = {
  name: "bookmarks.createFolder",
  title: "Create bookmark folder",
  description: "Create a folder in the bookmark tree.",
  category: "bookmarks",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ title: z.string().min(1).max(512), parentId: z.string().optional(), index: z.number().int().min(0).optional() }).strict(),
  output: z.object({ folder: z.object({ id: z.string(), title: z.string(), parentId: z.string().optional() }) }).strict(),
};

export const historyAdd: ToolDefinition = {
  name: "history.add",
  title: "Add history entry",
  description: "Add a page visit to the browser's history. Requires the history permission group.",
  category: "history",
  risk: "reversible",
  requiresApproval: false,
  input: z.object({ url: urlSchema, title: z.string().max(512).optional(), transition: z.enum(["link", "typed", "reload", "auto_bookmark"]).default("link") }).strict(),
  output: z.object({ added: z.literal(true), url: z.string() }).strict(),
};

const HistoryEntry = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  lastVisitTime: z.string(),
  visitCount: z.number().int(),
});

export const historySearch: ToolDefinition = {
  name: "history.search",
  title: "Search history",
  description:
    "Search browsing history. History is an opt-in permission group that must be enabled by the user, and each call is audited.",
  category: "history",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z
    .object({
      text: z.string().min(1).max(256),
      startTime: z.number().int().optional(),
      endTime: z.number().int().optional(),
      maxResults: z.number().int().min(1).max(500).default(50),
    })
    .strict(),
  output: z.object({ entries: z.array(HistoryEntry) }).strict(),
};

export const historyDelete: ToolDefinition = {
  name: "history.delete",
  title: "Delete history entries",
  description: "Delete selected history entries. Requires fresh approval.",
  category: "history",
  risk: "consequential",
  requiresApproval: true,
  input: z.object({ urls: z.array(z.string()).min(1).max(100) }).strict(),
  output: z.object({ deleted: z.number().int() }).strict(),
};

export const filesList: ToolDefinition = {
  name: "files.list",
  title: "List attached files",
  description:
    "List files the user attached in the Muze dashboard. Use a returned id as fileId with forms.setFile. Does not return file bytes.",
  category: "files",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: z
    .object({
      files: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.number().int(),
          createdAt: z.number().int(),
        }),
      ),
    })
    .strict(),
};

export const filesStat: ToolDefinition = {
  name: "files.stat",
  title: "File metadata",
  description: "Return metadata for one attached file by id. Does not return file bytes.",
  category: "files",
  risk: "sensitive-read",
  requiresApproval: false,
  input: z.object({ id: z.string().min(1).max(128) }).strict(),
  output: z
    .object({
      id: z.string(),
      name: z.string(),
      mimeType: z.string(),
      size: z.number().int(),
      createdAt: z.number().int(),
    })
    .strict(),
};

export const dataTools: ToolDefinition[] = [
  bookmarksSearch,
  bookmarksList,
  bookmarksCreate,
  bookmarksUpdate,
  bookmarksDelete,
  bookmarksMove,
  bookmarksCreateFolder,
  historySearch,
  historyAdd,
  historyDelete,
  filesList,
  filesStat,
];
