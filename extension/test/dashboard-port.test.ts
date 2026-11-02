import { describe, expect, it } from "vitest";
import {
  baseName,
  filesUnder,
  joinPath,
  listDirectory,
  parentPath,
  renameError,
  uniqueFolderName,
} from "../dashboard/file-tree.js";
import { createZip, crc32 } from "../dashboard/zip.js";
import { brandKeyForName } from "../dashboard/components/brand-icons.js";
import { taskProgress, taskStatusWord, timelineIconForStep } from "../dashboard/ui-logic.js";

const files = [
  { id: "1", name: "Invoices/invoice-march.pdf", mimeType: "application/pdf", size: 1200 },
  { id: "2", name: "Invoices/invoice-feb.pdf", mimeType: "application/pdf", size: 980 },
  { id: "3", name: "Invoices/2026/deep.pdf", mimeType: "application/pdf", size: 10 },
  { id: "4", name: "Screenshots/product-shot.png", mimeType: "image/png", size: 845 },
  { id: "5", name: "notes.txt", mimeType: "text/plain", size: 4 },
];

describe("file-tree directories over the flat store", () => {
  it("lists folders first with direct-child counts, then root files", () => {
    const listing = listDirectory(files, [], "");
    expect(listing.folders.map((folder) => folder.name)).toEqual(["Invoices", "Screenshots"]);
    // Invoices holds 2 direct files + 1 subfolder child (2026 counts as
    // one direct child; the deep file belongs to 2026, not Invoices).
    expect(listing.folders.find((folder) => folder.name === "Invoices")?.itemCount).toBe(3);
    expect(listing.folders.find((folder) => folder.name === "Screenshots")?.itemCount).toBe(1);
    expect(listing.files.map((file) => file.name)).toEqual(["notes.txt"]);
  });

  it("navigates into folders and honours registered empty folders", () => {
    const listing = listDirectory(files, ["Empty"], "Invoices");
    expect(listing.folders.map((folder) => folder.name)).toEqual(["2026"]);
    expect(listing.files.map((file) => baseName(file.name))).toEqual(["invoice-march.pdf", "invoice-feb.pdf"]);
    const root = listDirectory(files, ["Empty"], "");
    expect(root.folders.map((folder) => folder.name)).toContain("Empty");
    expect(root.folders.find((folder) => folder.name === "Empty")?.itemCount).toBe(0);
    const deep = listDirectory(files, [], "Invoices/2026");
    expect(deep.files.map((file) => baseName(file.name))).toEqual(["deep.pdf"]);
  });

  it("supports path helpers and unique folder names", () => {
    expect(joinPath("Invoices", "x.pdf")).toBe("Invoices/x.pdf");
    expect(joinPath("", "x.pdf")).toBe("x.pdf");
    expect(parentPath("Invoices/2026")).toBe("Invoices");
    expect(parentPath("Invoices")).toBe("");
    expect(baseName("Invoices/x.pdf")).toBe("x.pdf");
    expect(uniqueFolderName(["New folder"])).toBe("New folder 2");
    expect(uniqueFolderName([])).toBe("New folder");
    expect(filesUnder(files, "Invoices")).toHaveLength(3);
  });

  it("rejects empty, slash, and duplicate names on rename", () => {
    expect(renameError("", ["a"], null)).toBe("Name can't be empty");
    expect(renameError("  ", ["a"], null)).toBe("Name can't be empty");
    expect(renameError("a/b", ["a"], null)).toBe("Names can't contain /");
    expect(renameError("a", ["a", "b"], null)).toBe("That name is already used here");
    expect(renameError("a", ["a", "b"], "a")).toBeNull();
    expect(renameError("c", ["a", "b"], null)).toBeNull();
  });
});

describe("zip writer", () => {
  it("round-trips entries with correct names, CRCs, and contents", () => {
    const first = new TextEncoder().encode("hello");
    const second = new Uint8Array([0, 1, 2, 3]);
    const zip = createZip([
      { name: "a.txt", data: first },
      { name: "dir/b.bin", data: second },
    ]);
    const view = new DataView(zip.buffer);
    // End of central directory.
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(2);
    const centralStart = view.getUint32(eocd + 16, true);
    // First central header: name + CRC + size.
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50);
    const nameLen = view.getUint16(centralStart + 28, true);
    const name = new TextDecoder().decode(zip.slice(centralStart + 46, centralStart + 46 + nameLen));
    expect(name).toBe("a.txt");
    expect(view.getUint32(centralStart + 16, true)).toBe(crc32(first));
    // First local header points at the stored bytes.
    const localOffset = view.getUint32(centralStart + 42, true);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const stored = zip.slice(localOffset + 30 + localNameLen, localOffset + 30 + localNameLen + first.length);
    expect(new TextDecoder().decode(stored)).toBe("hello");
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("brand keys", () => {
  it("matches app and browser names loosely, unknown names to null", () => {
    expect(brandKeyForName("ChatGPT")).toBe("chatgpt");
    expect(brandKeyForName("Google Chrome")).toBe("chrome");
    expect(brandKeyForName("Microsoft Edge")).toBe("edge");
    expect(brandKeyForName("Claude")).toBe("claude");
    expect(brandKeyForName("Gemini")).toBe("gemini");
    expect(brandKeyForName("Firefox")).toBe("firefox");
    expect(brandKeyForName("Copilot")).toBe("copilot");
    expect(brandKeyForName("Something Else")).toBeNull();
    expect(brandKeyForName(null)).toBeNull();
  });
});

describe("reference task presentation", () => {
  it("maps statuses to Running / Completed / Failed words", () => {
    expect(taskStatusWord("running")).toBe("Running");
    expect(taskStatusWord("created")).toBe("Running");
    expect(taskStatusWord("done")).toBe("Completed");
    expect(taskStatusWord("failed")).toBe("Failed");
    expect(taskStatusWord("paused")).toBe("Paused");
  });

  it("never invents a total for unknown-total tasks", () => {
    expect(taskProgress(3, 8, 3)).toEqual({ text: "Step 3 of 8", percent: 38, indeterminate: false });
    expect(taskProgress(7, 0, 7)).toEqual({ text: "7 steps done so far · total unknown", percent: 0, indeterminate: true });
  });

  it("maps tools to the single timeline stroke set", () => {
    expect(timelineIconForStep("dom.click", "done")).toBe("pointer");
    expect(timelineIconForStep("dom.type", "running")).toBe("keyboard");
    expect(timelineIconForStep("tabs.navigate", "done")).toBe("nav-arrow");
    expect(timelineIconForStep("dom.click", "failed")).toBe("fail");
    expect(timelineIconForStep("screenshots.viewport", "done")).toBe("camera");
    expect(timelineIconForStep(undefined, "done")).toBe("check");
  });
});
