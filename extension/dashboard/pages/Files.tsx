import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { MAX_FILE_SIZE, type StoredFile } from "../../libs/files/index.js";
import { Icon } from "../components/Icon.js";
import { Button, Callout, Card, EmptyState, Skeleton } from "../components/primitives.js";
import { sendRequest } from "../logic.js";

type FileSummary = Omit<StoredFile, "data">;

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
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

export function FilesPage(): preact.JSX.Element {
  const [files, setFiles] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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
    try {
      for (const file of Array.from(selected)) {
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
      }
    } finally {
      if (input.current) input.current.value = "";
      setBusy(false);
      await load();
    }
  };

  const remove = async (id: string, name?: string): Promise<void> => {
    // Removing a file is destructive (uploads referencing it break), so
    // confirm first with a native dialog (documented dashboard choice).
    if (name !== undefined) {
      const ok = confirm(`Remove "${name}"? The AI will no longer be able to use this file.`);
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    const response = await sendRequest({ type: "muze/files/remove", id });
    if (!response.ok) setError(response.error ?? "Could not remove the file");
    setBusy(false);
    await load();
  };

  return (
    <div class="stack">
      {error ? <Callout tone="danger">{error}</Callout> : null}

      <Card
        title="Files"
        icon="file"
        description="Files stay on this device. Attach one here, then ask the AI to set it on a file input with forms.setFile."
        actions={files ? <span class="pill">{files.length} stored</span> : null}
      >
        <div
          class={"file-drop" + (dragging ? " is-over" : "")}
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
          <Icon name="file" size={22} />
          <span class="file-drop-title">{busy ? "Adding files…" : "Drop files here or click to choose"}</span>
          <span class="file-drop-hint">Up to {formatBytes(MAX_FILE_SIZE)} per file</span>
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

        {files === null ? (
          <div class="skeleton-list">
            <Skeleton width="80%" />
            <Skeleton width="65%" />
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            icon="file"
            title="No files yet"
            description="Add a PDF, image, or document to hand it to a page later."
          />
        ) : (
          <ul class="file-list">
            {files.map((file) => (
              <li class="file-row" key={file.id}>
                <span class="file-row-icon" aria-hidden="true">
                  <Icon name="file" size={16} />
                </span>
                <div class="file-row-main">
                  <span class="file-row-name" title={file.name}>
                    {file.name}
                  </span>
                  <span class="file-row-meta">
                    {formatBytes(file.size)} · {file.mimeType}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon="close"
                  ariaLabel={`Remove ${file.name}`}
                  disabled={busy}
                  onClick={() => void remove(file.id, file.name)}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
