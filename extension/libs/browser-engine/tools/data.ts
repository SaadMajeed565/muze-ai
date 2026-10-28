import {
  ToolErrorException,
  bookmarksCreate,
  bookmarksCreateFolder,
  bookmarksDelete,
  bookmarksList,
  bookmarksMove,
  bookmarksSearch,
  bookmarksUpdate,
  filesList,
  filesStat,
  historyAdd,
  historyDelete,
  historySearch,
} from "../../tool-contracts/index.js";
import { getFile, listFiles } from "../../files/index.js";
import type { BookmarkRecord } from "../context.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import { raceWithAbort, validateUrlInput } from "./helpers.js";

function toBookmark(record: BookmarkRecord): { id: string; parentId?: string; title: string; url?: string; dateAdded?: string; folder: string } {
  return {
    id: record.id,
    parentId: record.parentId,
    title: record.title,
    url: record.url,
    dateAdded: record.dateAdded,
    folder: record.folder,
  };
}

export const dataToolHandlers: RegisteredTool[] = [
  defineTool(bookmarksSearch, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const data = input as { query: string; limit: number };
    const records = await raceWithAbort(ctx.bookmarks.search(data.query, data.limit), signal);
    return { bookmarks: records.map(toBookmark) };
  }),

  defineTool(bookmarksList, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const data = input as { folderId?: string; limit: number };
    const result = await raceWithAbort(ctx.bookmarks.list(data.folderId, data.limit), signal);
    return { bookmarks: result.bookmarks.map(toBookmark), folders: result.folders };
  }),

  defineTool(bookmarksCreate, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const data = input as { title: string; url: string; parentId?: string };
    const record = await raceWithAbort(ctx.bookmarks.create({ title: data.title, url: validateUrlInput(data.url, false), parentId: data.parentId }), signal);
    return { bookmark: toBookmark(record) };
  }),

  defineTool(bookmarksUpdate, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const data = input as { id: string; title?: string; url?: string };
    const record = await raceWithAbort(ctx.bookmarks.update({
      id: data.id,
      title: data.title,
      url: data.url ? validateUrlInput(data.url, false) : undefined,
    }), signal);
    return { bookmark: toBookmark(record) };
  }),

  defineTool(bookmarksDelete, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const { id } = input as { id: string };
    await raceWithAbort(ctx.bookmarks.remove(id), signal);
    return { deleted: true as const, id };
  }),

  defineTool(bookmarksMove, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const data = input as { id: string; parentId?: string; index?: number };
    const record = await raceWithAbort(ctx.bookmarks.move({ id: data.id, parentId: data.parentId, index: data.index }), signal);
    return { bookmark: toBookmark(record) };
  }),

  defineTool(bookmarksCreateFolder, async (input, { ctx, signal }) => {
    if (!ctx.bookmarks) throw new ToolErrorException("UNSUPPORTED", "Bookmarks capability is not enabled");
    const data = input as { title: string; parentId?: string; index?: number };
    const folder = await raceWithAbort(ctx.bookmarks.createFolder({ title: data.title, parentId: data.parentId, index: data.index }), signal);
    return { folder };
  }),

  defineTool(historySearch, async (input, { ctx, signal }) => {
    if (!ctx.history) throw new ToolErrorException("UNSUPPORTED", "History capability is not enabled");
    const data = input as { text: string; startTime?: number; endTime?: number; maxResults: number };
    const entries = await raceWithAbort(ctx.history.search(data), signal);
    return { entries };
  }),

  defineTool(historyAdd, async (input, { ctx, signal }) => {
    if (!ctx.history) throw new ToolErrorException("UNSUPPORTED", "History capability is not enabled");
    const data = input as { url: string; title?: string; transition: string };
    const url = validateUrlInput(data.url, false);
    await raceWithAbort(ctx.history.add({ url, title: data.title, transition: data.transition }), signal);
    return { added: true as const, url };
  }),

  defineTool(historyDelete, async (input, { ctx, signal }) => {
    if (!ctx.history) throw new ToolErrorException("UNSUPPORTED", "History capability is not enabled");
    const { urls } = input as { urls: string[] };
    const deleted = await raceWithAbort(ctx.history.remove(urls), signal);
    return { deleted };
  }),

  defineTool(filesList, async (input, { signal }) => {
    if (typeof indexedDB === "undefined") throw new ToolErrorException("UNSUPPORTED", "File store is not available in this context");
    const data = input as { limit: number };
    const files = await raceWithAbort(listFiles(), signal);
    return {
      files: files.slice(0, data.limit).map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        createdAt: file.createdAt,
      })),
    };
  }),

  defineTool(filesStat, async (input, { signal }) => {
    if (typeof indexedDB === "undefined") throw new ToolErrorException("UNSUPPORTED", "File store is not available in this context");
    const { id } = input as { id: string };
    const file = await raceWithAbort(getFile(id), signal);
    if (!file) throw new ToolErrorException("NOT_FOUND", "File not found in store");
    return { id: file.id, name: file.name, mimeType: file.mimeType, size: file.size, createdAt: file.createdAt };
  }),
];
