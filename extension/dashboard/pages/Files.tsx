import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MAX_FILE_SIZE, type StoredFile } from "../../libs/files/index.js";
import { Icon } from "../components/Icon.js";
import { Button, EmptyState } from "../components/primitives.js";
import { ErrorState, Page, SectionSkeleton } from "../components/layout.js";
import { sendRequest } from "../logic.js";
import { showToast } from "../components/feedback.js";
import { KebabMenu, Sheet } from "../components/shared.js";
import {
  baseName,
  filesUnder,
  joinPath,
  listDirectory,
  loadFolderRegistry,
  parentPath,
  registryUnder,
  renameError,
  saveFolderRegistry,
  uniqueFolderName,
  type FileMeta,
} from "../file-tree.js";
import { createZip } from "../zip.js";
import { renameFileViaStore, renameFolderViaStore } from "../file-rename.js";

type FileSummary = Omit<StoredFile, "data">;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileKind(mimeType: string): { label: string; tile: string } {
  if (mimeType.startsWith("image/")) return { label: "IMG", tile: "img" };
  if (mimeType === "application/pdf") return { label: "PDF", tile: "pdf" };
  if (mimeType.startsWith("text/")) return { label: "TXT", tile: "txt" };
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) return { label: "DOC", tile: "doc" };
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return { label: "ZIP", tile: "zip" };
  return { label: "FILE", tile: "txt" };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface UploadState {
  name: string;
  index: number;
  total: number;
}

interface RenameTarget {
  type: "file" | "folder";
  currentName: string;
  fileId?: string;
  folderPath?: string;
}

interface DeleteTarget {
  type: "file" | "folder";
  name: string;
  fileId?: string;
  folderPath?: string;
  itemCount?: number;
}

/**
 * Files in the reference language: directory tree (folders first,
 * breadcrumb path, back chevron, New folder), kebab menus per row,
 * rename sheet with validation, delete confirm sheet, folder download
 * as a ZIP. The store itself is flat: folder membership is the "/"
 * prefix in the stored name, and empty folders live in a
 * dashboard-owned registry — see file-tree.ts. Rename goes through
 * the real API as get → remove → attach, which changes the file id;
 * the store has no rename endpoint.
 */
export function FilesPage(): preact.JSX.Element {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [registry, setRegistry] = useState<string[]>([]);
  const [path, setPath] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<UploadState | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const dragCount = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);

  const currentPath = path.join("/");
  const listing = files ? listDirectory(files, registry, currentPath) : null;

  const load = useCallback(async (): Promise<void> => {
    const response = await sendRequest({ type: "muze/files/list" });
    if (response.ok) {
      setFiles(((response.data as FileSummary[] | undefined) ?? []).map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size })));
      setRegistry(await loadFolderRegistry());
    } else setError(response.error ?? "Could not load your files");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (selected: FileList | File[]): Promise<void> => {
    setBusy(true);
    setError(null);
    const list = Array.from(selected);
    let added = 0;
    const failed: string[] = [];
    try {
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        setUploading({ name: file.name, index: index + 1, total: list.length });
        if (file.size > MAX_FILE_SIZE) {
          failed.push(`${file.name} is larger than ${formatBytes(MAX_FILE_SIZE)}`);
          continue;
        }
        // Files land in the open folder: the stored name carries the
        // folder prefix, which is what the tree view reads back.
        const response = await sendRequest({
          type: "muze/files/attach",
          file: {
            name: joinPath(currentPath, file.name),
            mimeType: file.type || "application/octet-stream",
            dataBase64: toBase64(await file.arrayBuffer()),
          },
        });
        if (!response.ok) failed.push(response.error ?? `Could not attach ${file.name}`);
        else added += 1;
      }
    } finally {
      if (input.current) input.current.value = "";
      setBusy(false);
      setUploading(null);
      await load();
      if (failed.length > 0) setError(failed.join(" · "));
      if (added > 0) showToast(added === 1 ? "File added" : `${added} files added`);
    }
  };

  const createFolder = async (): Promise<void> => {
    if (!listing) return;
    const siblings = [...listing.folders.map((folder) => folder.name), ...listing.files.map((file) => baseName(file.name))];
    const name = uniqueFolderName(siblings);
    const next = [...registry, joinPath(currentPath, name)];
    setRegistry(next);
    await saveFolderRegistry(next);
    showToast("Folder created");
  };

  const downloadFile = async (file: FileMeta): Promise<void> => {
    const response = await sendRequest({ type: "muze/files/get", id: file.id });
    const data = (response as unknown as { data?: { dataBase64?: string; mimeType?: string } }).data;
    if (!response.ok || !data?.dataBase64) {
      setError(response.error ?? "Could not download the file");
      return;
    }
    downloadBlob(new Blob([fromBase64(data.dataBase64)], { type: data.mimeType ?? file.mimeType }), baseName(file.name));
    showToast("Download started");
  };

  const downloadFolderZip = async (folderPath: string): Promise<void> => {
    if (!files) return;
    const contained = filesUnder(files, folderPath);
    if (contained.length === 0) {
      showToast("Folder is empty");
      return;
    }
    setBusy(true);
    try {
      const entries: { name: string; data: Uint8Array }[] = [];
      for (const file of contained) {
        const response = await sendRequest({ type: "muze/files/get", id: file.id });
        const data = (response as unknown as { data?: { dataBase64?: string } }).data;
        if (!response.ok || !data?.dataBase64) {
          setError(`Could not read ${baseName(file.name)}`);
          return;
        }
        entries.push({ name: file.name.slice(folderPath.length + 1), data: fromBase64(data.dataBase64) });
      }
      downloadBlob(new Blob([createZip(entries)], { type: "application/zip" }), `${baseName(folderPath)}.zip`);
      showToast(`Downloading "${baseName(folderPath)}" as a ZIP`);
    } finally {
      setBusy(false);
    }
  };

  const renameFile = async (file: FileMeta, newName: string): Promise<boolean> => {
    const result = await renameFileViaStore(sendRequest, file, newName);
    if (!result.ok) setError(result.error ?? "Could not rename the file");
    return result.ok;
  };

  const renameFolder = async (oldPath: string, newPath: string): Promise<boolean> => {
    const result = await renameFolderViaStore(sendRequest, files ?? [], oldPath, newPath);
    if (!result.ok) setError(result.error ?? "Could not rename the folder");
    return result.ok;
  };

  const saveRename = async (): Promise<void> => {
    if (!renameTarget || !listing) return;
    const siblings = [...listing.folders.map((folder) => folder.name), ...listing.files.map((file) => baseName(file.name))];
    const problem = renameError(renameValue, siblings, renameTarget.currentName);
    if (problem) {
      // Validation keeps the sheet open, like the reference.
      setRenameProblem(problem);
      return;
    }
    const cleaned = renameValue.trim();
    setBusy(true);
    try {
      if (renameTarget.type === "file" && renameTarget.fileId) {
        const file = files?.find((item) => item.id === renameTarget.fileId);
        if (!file) return;
        const ok = await renameFile(file, joinPath(currentPath, cleaned));
        if (!ok) return;
      } else if (renameTarget.type === "folder" && renameTarget.folderPath) {
        const oldPath = renameTarget.folderPath;
        const newPath = joinPath(parentPath(oldPath), cleaned);
        const ok = await renameFolder(oldPath, newPath);
        if (!ok) return;
        const nextRegistry = registry.map((entry) =>
          entry === oldPath ? newPath : entry.startsWith(`${oldPath}/`) ? newPath + entry.slice(oldPath.length) : entry,
        );
        setRegistry(nextRegistry);
        await saveFolderRegistry(nextRegistry);
        // Stay in the renamed folder if it was open.
        if (currentPath === oldPath) setPath(newPath.split("/").filter(Boolean));
        else if (currentPath.startsWith(`${oldPath}/`)) setPath((newPath + currentPath.slice(oldPath.length)).split("/").filter(Boolean));
      }
      setRenameTarget(null);
      setRenameProblem(null);
      showToast("Renamed");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      if (deleteTarget.type === "file" && deleteTarget.fileId) {
        const response = await sendRequest({ type: "muze/files/remove", id: deleteTarget.fileId });
        if (!response.ok) setError(response.error ?? "Could not remove the file");
        else showToast("File removed");
      } else if (deleteTarget.type === "folder" && deleteTarget.folderPath) {
        const contained = files ? filesUnder(files, deleteTarget.folderPath) : [];
        let failed = 0;
        for (const file of contained) {
          const response = await sendRequest({ type: "muze/files/remove", id: file.id });
          if (!response.ok) failed += 1;
        }
        const removed = registryUnder(registry, deleteTarget.folderPath);
        const nextRegistry = registry.filter((entry) => !removed.includes(entry));
        setRegistry(nextRegistry);
        await saveFolderRegistry(nextRegistry);
        if (failed > 0) setError(`${failed} file${failed === 1 ? "" : "s"} could not be removed`);
        else showToast("Folder removed");
        if (currentPath === deleteTarget.folderPath || currentPath.startsWith(`${deleteTarget.folderPath}/`)) {
          setPath(parentPath(deleteTarget.folderPath).split("/").filter(Boolean));
        }
      }
      setDeleteTarget(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openRename = (target: RenameTarget): void => {
    setRenameTarget(target);
    setRenameValue(target.currentName);
    setRenameProblem(null);
    window.setTimeout(() => {
      renameInput.current?.focus();
      renameInput.current?.select();
    }, 50);
  };

  const crumbs = path.map((segment, index) => ({ segment, depth: index + 1 }));
  const heading = path.length ? path[path.length - 1] : "Stored files";
  const totalCount = listing ? listing.folders.length + listing.files.length : 0;

  return (
    <Page title="Files" subtitle="Files stay on this device.">
      {error ? <ErrorState message={error} /> : null}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          dragCount.current = Math.max(0, dragCount.current - 1);
          if (dragCount.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragCount.current = 0;
          setDragging(false);
          if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files);
        }}
      >
        <div
          class={"drop" + (dragging ? " over" : "")}
          role="button"
          tabIndex={0}
          aria-label="Add files"
          onClick={() => input.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              input.current?.click();
            }
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            dragCount.current += 1;
            setDragging(true);
          }}
        >
          <Icon name="upload" size={22} />
          <div>
            <b style={{ color: "var(--fg)" }}>
              {uploading ? `Adding ${uploading.name} (${uploading.index} of ${uploading.total})` : "Drop files here or tap to choose"}
            </b>
            <br />
            <span style={{ fontSize: "12px" }}>Files here can be used by your AI app inside tasks. Max {formatBytes(MAX_FILE_SIZE)} each.</span>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const selected = event.currentTarget.files;
            if (selected?.length) void upload(selected);
          }}
        />
        <Button class="mt12" block disabled={busy || !listing} onClick={() => void createFolder()}>
          <Icon name="folder-plus" size={18} /> New folder
        </Button>

        {path.length > 0 ? (
          <div style={{ marginTop: "14px", fontSize: "13px", display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              aria-label="Back to parent folder"
              onClick={() => setPath(path.slice(0, -1))}
              style={{ flex: "none", width: "32px", height: "32px", border: "none", background: "none", color: "var(--fg)", display: "grid", placeItems: "center", cursor: "pointer" }}
            >
              <Icon name="chevron-left" size={18} />
            </button>
            <div>
              <button
                type="button"
                style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--muted)", cursor: "pointer" }}
                onClick={() => setPath([])}
              >
                Files
              </button>
              {crumbs.map((crumb) => (
                <span key={crumb.depth}>
                  <span class="muted"> / </span>
                  {crumb.depth === path.length ? (
                    <span style={{ fontWeight: 600 }}>{crumb.segment}</span>
                  ) : (
                    <button
                      type="button"
                      style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--muted)", cursor: "pointer" }}
                      onClick={() => setPath(path.slice(0, crumb.depth))}
                    >
                      {crumb.segment}
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <h2 class="sec" style={{ marginTop: "14px" }}>
          {heading} ({totalCount})
        </h2>
        <div id="fileList">
          {!listing ? (
            <SectionSkeleton />
          ) : totalCount === 0 ? (
            <EmptyState
              icon="file"
              title={path.length ? "This folder is empty" : "No files yet"}
              description={path.length ? "Drop files here or add new ones." : "Add a PDF, image, or document to hand it to your AI app later."}
            />
          ) : (
            <>
              {listing.folders.map((folder) => (
                <div class="row" key={folder.path} style={{ cursor: "pointer" }} onClick={() => setPath(folder.path.split("/"))}>
                  <span class="tile sm" style={{ background: "var(--surface2)", color: "var(--muted)" }}>
                    <Icon name="folder" size={18} />
                  </span>
                  <span style={{ flex: 1 }}>
                    <span class="name">{folder.name}</span>
                    <br />
                    <span class="meta">
                      {folder.itemCount} item{folder.itemCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <KebabMenu
                    ariaLabel={`Actions for ${folder.name}`}
                    items={[
                      { label: "Open", onSelect: () => setPath(folder.path.split("/")) },
                      { label: "Download as ZIP", onSelect: () => void downloadFolderZip(folder.path) },
                      { label: "Rename", onSelect: () => openRename({ type: "folder", currentName: folder.name, folderPath: folder.path }) },
                      {
                        label: "Remove",
                        danger: true,
                        onSelect: () =>
                          setDeleteTarget({ type: "folder", name: folder.name, folderPath: folder.path, itemCount: folder.itemCount }),
                      },
                    ]}
                  />
                </div>
              ))}
              {listing.files.map((file) => {
                const kind = fileKind(file.mimeType);
                return (
                  <div class="row" key={file.id} style={{ cursor: "default" }}>
                    <span class={"tile sm filetile " + kind.tile}>{kind.label}</span>
                    <span style={{ flex: 1 }}>
                      <span class="name">{baseName(file.name)}</span>
                      <br />
                      <span class="meta">{formatBytes(file.size)}</span>
                    </span>
                    <KebabMenu
                      ariaLabel={`Actions for ${baseName(file.name)}`}
                      items={[
                        { label: "Download", onSelect: () => void downloadFile(file) },
                        { label: "Rename", onSelect: () => openRename({ type: "file", currentName: baseName(file.name), fileId: file.id }) },
                        { label: "Remove", danger: true, onSelect: () => setDeleteTarget({ type: "file", name: baseName(file.name), fileId: file.id }) },
                      ]}
                    />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>

      <Sheet open={renameTarget !== null} label="Rename" onClose={() => { setRenameTarget(null); setRenameProblem(null); }}>
        <input
          ref={renameInput}
          class="field mt12"
          placeholder="Name"
          value={renameValue}
          disabled={busy}
          onInput={(event) => setRenameValue((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void saveRename();
          }}
        />
        {renameProblem ? <p style={{ color: "var(--red)", fontSize: "13px" }}>{renameProblem}</p> : null}
        <Button variant="primary" block class="mt12" disabled={busy} onClick={() => void saveRename()}>
          Save
        </Button>
      </Sheet>

      <Sheet open={deleteTarget !== null} label={deleteTarget?.type === "folder" ? "Delete folder?" : "Delete file?"} onClose={() => setDeleteTarget(null)}>
        <p class="muted">
          {deleteTarget?.type === "folder"
            ? `"${deleteTarget.name}" and everything inside it (${deleteTarget.itemCount} item${deleteTarget.itemCount === 1 ? "" : "s"}) will be permanently deleted.`
            : `"${deleteTarget?.name}" will be permanently deleted.`}
        </p>
        <div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
          <Button block onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button variant="danger" block disabled={busy} onClick={() => void confirmDelete()}>
            Delete
          </Button>
        </div>
      </Sheet>
    </Page>
  );
}
