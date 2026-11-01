import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MAX_FILE_SIZE, type StoredFile } from "../../libs/files/index.js";
import type { IconName } from "../logic.js";
import { Icon } from "../components/Icon.js";
import { Button, EmptyState } from "../components/primitives.js";
import { ErrorState, ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";
import { sendRequest } from "../logic.js";
import { showToast } from "../components/feedback.js";
import { useConfirm } from "../components/confirm.js";

type FileSummary = Omit<StoredFile, "data">;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileKind(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "Image";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("text/")) return "Text document";
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) return "Spreadsheet";
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return "Archive";
  return "Document";
}

function fileIcon(mimeType: string): IconName {
  return mimeType.startsWith("image/") ? "image" : "file";
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

interface UploadState {
  name: string;
  index: number;
  total: number;
}

/**
 * Files: drop zone, plain file names, type icons, size, and upload
 * progress. No raw MIME strings.
 */
export function FilesPage(): preact.JSX.Element {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<UploadState | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const load = useCallback(async (): Promise<void> => {
    const response = await sendRequest({ type: "muze/files/list" });
    if (response.ok) setFiles((response.data as FileSummary[] | undefined) ?? []);
    else setError(response.error ?? "Could not load your files");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (selected: FileList | File[]): Promise<void> => {
    setBusy(true);
    setError(null);
    const list = Array.from(selected);
    let added = 0;
    try {
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        setUploading({ name: file.name, index: index + 1, total: list.length });
        if (file.size > MAX_FILE_SIZE) {
          setError(`${file.name} is larger than ${formatBytes(MAX_FILE_SIZE)}`);
          continue;
        }
        const response = await sendRequest({
          type: "muze/files/attach",
          file: {
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            dataBase64: toBase64(await file.arrayBuffer()),
          },
        });
        if (!response.ok) setError(response.error ?? `Could not attach ${file.name}`);
        else added += 1;
      }
    } finally {
      if (input.current) input.current.value = "";
      setBusy(false);
      setUploading(null);
      await load();
      if (added > 0) showToast(added === 1 ? "File added" : `${added} files added`);
    }
  };

  const remove = async (id: string, name: string): Promise<void> => {
    const ok = await confirm({
      title: `Remove “${name}”?`,
      body: "The AI will no longer be able to use this file. This can't be undone.",
      confirmLabel: "Remove file",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const response = await sendRequest({ type: "muze/files/remove", id });
    if (!response.ok) setError(response.error ?? "Could not remove the file");
    else showToast("File removed");
    setBusy(false);
    await load();
  };

  return (
    <Page title="Files" subtitle="Files stay on this device." action={files ? <span class="ui-pill">{files.length} stored</span> : null}>
      {error ? <ErrorState message={error} /> : null}
      <Section title="Add a file" description="Attach a file here, then ask your AI app to use it.">
        <div
          class={"file-drop" + (dragging ? " is-over" : "") + (busy ? " is-busy" : "")}
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
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files);
          }}
        >
          <span class="file-drop-icon" aria-hidden="true">
            <Icon name={uploading ? "pulse" : "upload"} size={24} />
          </span>
          <span class="file-drop-title">
            {uploading ? `Adding ${uploading.name} (${uploading.index} of ${uploading.total})` : "Drop files here or choose files"}
          </span>
          <span class="file-drop-hint">Up to {formatBytes(MAX_FILE_SIZE)} per file</span>
          {uploading ? (
            <span class="file-drop-progress" aria-hidden="true">
              <span style={{ width: `${Math.round((uploading.index / uploading.total) * 100)}%` }} />
            </span>
          ) : null}
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
      </Section>

      <Section title="Stored files">
        {files === null ? (
          <SectionSkeleton />
        ) : files.length === 0 ? (
          <EmptyState icon="file" title="No files yet" description="Add a PDF, image, or document to hand it to your AI app later." />
        ) : (
          <ul class="ui-list">
            {files.map((file) => (
              <ListRow
                key={file.id}
                icon={fileIcon(file.mimeType)}
                title={file.name}
                meta={`${fileKind(file.mimeType)} · ${formatBytes(file.size)}`}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="trash"
                    ariaLabel={`Remove ${file.name}`}
                    disabled={busy}
                    onClick={() => void remove(file.id, file.name)}
                  />
                }
              />
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
