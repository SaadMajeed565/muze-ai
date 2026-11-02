/**
 * Directory view over the flat file store. The store itself has no
 * folders (see libs/files): folder membership is encoded in the stored
 * file name ("Invoices/invoice-march.pdf"), and empty folders — which
 * hold no file and so cannot be encoded that way — live in a
 * dashboard-owned registry in chrome.storage.local. Nothing here fakes
 * persistence: a folder exists in the UI only if the registry or at
 * least one stored file name says so, and every rename/delete goes
 * through the real file API (get → remove → attach under the new
 * name, which does change the file's id — the store has no rename).
 */

export interface FileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface FolderEntry {
  name: string;
  path: string;
  itemCount: number;
}

export interface DirectoryListing {
  folders: FolderEntry[];
  files: FileMeta[];
}

/** Dashboard-owned registry key for empty folders. */
export const FOLDER_REGISTRY_KEY = "muze.fileFolders";

export function splitPath(name: string): string[] {
  return name.split("/").filter((segment) => segment.length > 0);
}

export function joinPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

/** Direct children of `path`: folders first, then files. */
export function listDirectory(files: readonly FileMeta[], registry: readonly string[], path: string): DirectoryListing {
  const prefix = path ? `${path}/` : "";
  const folderNames = new Set<string>();
  for (const folder of registry) {
    if (path === "") {
      const first = splitPath(folder)[0];
      if (first) folderNames.add(first);
    } else if (folder.startsWith(prefix)) {
      const first = splitPath(folder.slice(prefix.length))[0];
      if (first) folderNames.add(first);
    }
  }
  const directFiles: FileMeta[] = [];
  for (const file of files) {
    if (!file.name.startsWith(prefix)) continue;
    const rest = file.name.slice(prefix.length);
    const segments = splitPath(rest);
    if (segments.length === 1) {
      directFiles.push(file);
    } else if (segments.length > 1) {
      folderNames.add(segments[0]);
    }
  }
  const folders: FolderEntry[] = [...folderNames].sort((a, b) => a.localeCompare(b)).map((name) => {
    const folderPath = joinPath(path, name);
    const childPrefix = `${folderPath}/`;
    let directFiles = 0;
    const subfolders = new Set<string>();
    for (const file of files) {
      if (!file.name.startsWith(childPrefix)) continue;
      const segments = splitPath(file.name.slice(childPrefix.length));
      if (segments.length === 1) directFiles += 1;
      else if (segments.length > 1) subfolders.add(segments[0]);
    }
    for (const folder of registry) {
      if (parentPath(folder) === folderPath) subfolders.add(baseName(folder));
    }
    return { name, path: folderPath, itemCount: directFiles + subfolders.size };
  });
  // A registered empty folder has no files: its count stays 0, which
  // is honest — the empty state names it as empty.
  return { folders, files: directFiles };
}

/** All files whose stored name lives under `path` (any depth). */
export function filesUnder(files: readonly FileMeta[], path: string): FileMeta[] {
  const prefix = path ? `${path}/` : "";
  return files.filter((file) => file.name.startsWith(prefix));
}

/** All registry paths under `path`, including `path` itself. */
export function registryUnder(registry: readonly string[], path: string): string[] {
  const prefix = path ? `${path}/` : "";
  return registry.filter((folder) => folder === path || folder.startsWith(prefix));
}

/** Unique folder name among siblings, "New folder", "New folder 2", … */
export function uniqueFolderName(existing: readonly string[]): string {
  let name = "New folder";
  let n = 2;
  while (existing.includes(name)) {
    name = `New folder ${n++}`;
  }
  return name;
}

/**
 * Rename validation, exactly as the reference: empty names, names
 * containing "/", and sibling duplicates are rejected — and the sheet
 * stays open, so the caller must not close it on a non-null return.
 */
export function renameError(name: string, siblings: readonly string[], selfName: string | null): string | null {
  const cleaned = name.trim();
  if (!cleaned) return "Name can't be empty";
  if (cleaned.includes("/")) return "Names can't contain /";
  if (siblings.some((sibling) => sibling !== selfName && sibling === cleaned)) return "That name is already used here";
  return null;
}

export async function loadFolderRegistry(): Promise<string[]> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
    const stored = await chrome.storage.local.get([FOLDER_REGISTRY_KEY]);
    const value = stored[FOLDER_REGISTRY_KEY];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export async function saveFolderRegistry(paths: string[]): Promise<void> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [FOLDER_REGISTRY_KEY]: paths });
  } catch {
    // Registry loss only hides empty folders; files themselves are
    // unaffected, so this never blocks the file action itself.
  }
}
