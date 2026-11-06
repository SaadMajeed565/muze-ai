import { baseName, filesUnder, type FileMeta } from "./file-tree.js";

/**
 * Files-rename execution (H2 fix, V2-46): the attach-first + rollback
 * protocol, extracted from dashboard/pages/Files.tsx so it can be
 * failure-injection tested without rendering the component. The store
 * has no rename endpoint, so a rename is get → attach(new) →
 * remove(old); the file id changes on rename.
 *
 * `request` is the dashboard `sendRequest` (or a test fake with the
 * same `muze/files/get|attach|remove` shape). Every function returns
 * `{ ok, error }` instead of touching component state; the caller
 * surfaces `error` and only rewrites the folder registry on full
 * success.
 */
export type FileStoreRequest = (request: unknown) => Promise<{ ok: boolean; error?: string; data?: unknown }>;

export interface RenameResult {
  ok: boolean;
  error?: string;
}

type FileData = { dataBase64?: string; mimeType?: string };
type AttachedData = { id?: string };

/** Single-file rename: attach the new copy FIRST, then remove the old. */
export async function renameFileViaStore(
  request: FileStoreRequest,
  file: FileMeta,
  newName: string,
): Promise<RenameResult> {
  const response = await request({ type: "muze/files/get", id: file.id });
  const data = (response as unknown as { data?: FileData }).data;
  if (!response.ok || !data?.dataBase64) {
    return { ok: false, error: response.error ?? "Could not read the file" };
  }
  // Attach the new copy FIRST: the old file stays untouched until the new
  // copy exists, so a failed attach can never lose the file.
  const attached = await request({
    type: "muze/files/attach",
    file: { name: newName, mimeType: data.mimeType ?? file.mimeType, dataBase64: data.dataBase64 },
  });
  const attachedData = (attached as unknown as { data?: AttachedData }).data;
  if (!attached.ok || !attachedData?.id) {
    return { ok: false, error: attached.error ?? "Could not rename the file" };
  }
  const removed = await request({ type: "muze/files/remove", id: file.id });
  if (!removed.ok) {
    // Roll back the new copy so a failed rename leaves no duplicate behind.
    await request({ type: "muze/files/remove", id: attachedData.id });
    return { ok: false, error: removed.error ?? "Could not rename the file" };
  }
  return { ok: true };
}

// Folder rename in phases so a mid-rename failure never splits the folder:
// read all bytes, attach every new copy, then remove the old copies. Any
// failure before the last phase leaves the old files untouched; a failure
// while removing restores already-removed files from their staged bytes.
// The registry is only rewritten by the caller on full success.
export async function renameFolderViaStore(
  request: FileStoreRequest,
  files: readonly FileMeta[],
  oldPath: string,
  newPath: string,
): Promise<RenameResult> {
  const contained = filesUnder(files, oldPath);
  const staged: { file: FileMeta; newName: string; mimeType: string; dataBase64: string }[] = [];
  for (const file of contained) {
    const response = await request({ type: "muze/files/get", id: file.id });
    const data = (response as unknown as { data?: FileData }).data;
    if (!response.ok || !data?.dataBase64) {
      return { ok: false, error: response.error ?? `Could not read ${baseName(file.name)}` };
    }
    staged.push({ file, newName: newPath + file.name.slice(oldPath.length), mimeType: data.mimeType ?? file.mimeType, dataBase64: data.dataBase64 });
  }
  const attachedIds = new Map<string, string>();
  for (const item of staged) {
    const attached = await request({ type: "muze/files/attach", file: { name: item.newName, mimeType: item.mimeType, dataBase64: item.dataBase64 } });
    const attachedData = (attached as unknown as { data?: AttachedData }).data;
    if (!attached.ok || !attachedData?.id) {
      for (const newId of attachedIds.values()) await request({ type: "muze/files/remove", id: newId });
      return { ok: false, error: attached.error ?? "Could not rename the folder" };
    }
    attachedIds.set(item.file.id, attachedData.id);
  }
  const removedOlds: typeof staged = [];
  for (const item of staged) {
    const removed = await request({ type: "muze/files/remove", id: item.file.id });
    if (!removed.ok) {
      for (const done of removedOlds) {
        await request({ type: "muze/files/attach", file: { name: done.file.name, mimeType: done.mimeType, dataBase64: done.dataBase64 } });
        const newId = attachedIds.get(done.file.id);
        if (newId) await request({ type: "muze/files/remove", id: newId });
      }
      const newId = attachedIds.get(item.file.id);
      if (newId) await request({ type: "muze/files/remove", id: newId });
      return { ok: false, error: removed.error ?? "Could not rename the folder" };
    }
    removedOlds.push(item);
  }
  return { ok: true };
}
