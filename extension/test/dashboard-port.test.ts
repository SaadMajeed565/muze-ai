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
import { TOOL_NAMES } from "../libs/tool-contracts/index.js";

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

describe("timeline family icons", () => {
  it("covers every family with at least one tool", () => {
    expect(timelineIconForStep("dom.drag", "running")).toBe("drag");
    expect(timelineIconForStep("page.read", "running")).toBe("eye");
    expect(timelineIconForStep("tabs.close", "running")).toBe("tab");
    expect(timelineIconForStep("forms.submit", "running")).toBe("send");
    expect(timelineIconForStep("forms.upload", "running")).toBe("upload");
    expect(timelineIconForStep("files.list", "running")).toBe("folder");
    expect(timelineIconForStep("bookmarks.create", "running")).toBe("bookmark");
    expect(timelineIconForStep("history.search", "running")).toBe("history-rewind");
    expect(timelineIconForStep("downloads.start", "running")).toBe("download");
    expect(timelineIconForStep("clipboard.write", "running")).toBe("clipboard");
    expect(timelineIconForStep("browser.info", "running")).toBe("info");
    expect(timelineIconForStep("devtools.console", "running")).toBe("wrench");
    expect(timelineIconForStep("workflows.summarizePage", "running")).toBe("flow");
    expect(timelineIconForStep("dom.waitFor", "running")).toBe("clock");
    expect(timelineIconForStep("tasks.pause", "running")).toBe("checklist");
    expect(timelineIconForStep("dom.hover", "running")).toBe("pointer");
    expect(timelineIconForStep("dom.scroll", "running")).toBe("mouse");
  });

  it("fixes the pressAt and navigation fall-throughs", () => {
    // dom.pressAt used to fall through to pointer; navigation.* used to
    // fall through to pointer as well.
    expect(timelineIconForStep("dom.pressAt", "running")).toBe("keyboard");
    expect(timelineIconForStep("navigation.back", "running")).toBe("nav-arrow");
    expect(timelineIconForStep("navigation.open", "running")).toBe("nav-arrow");
    expect(timelineIconForStep("navigation.wait", "running")).toBe("nav-arrow");
    expect(timelineIconForStep("tabs.reload", "running")).toBe("nav-arrow");
  });

  it("failed overrides family, done keeps family, unknown falls back", () => {
    expect(timelineIconForStep("dom.drag", "failed")).toBe("fail");
    expect(timelineIconForStep("dom.drag", "done")).toBe("drag");
    expect(timelineIconForStep("workflows.summarizePage", "done")).toBe("flow");
    expect(timelineIconForStep("some.future.tool", "running")).toBe("pointer");
    expect(timelineIconForStep("some.future.tool", "done")).toBe("check");
    expect(timelineIconForStep(undefined, "running")).toBe("pointer");
  });

  it("maps every registered tool to its family icon (no known tool hits the fallback)", () => {
    const expected: Record<string, string> = {
      // Pointer-device actions.
      "dom.click": "pointer", "dom.clickAt": "pointer", act: "pointer",
      "dom.hover": "pointer", "dom.moveTo": "pointer", "dom.focus": "pointer",
      // Typing and field edits.
      "dom.type": "keyboard", "dom.typeAt": "keyboard", "dom.fill": "keyboard",
      "dom.press": "keyboard", "dom.pressAt": "keyboard", "dom.clear": "keyboard",
      "dom.select": "keyboard", "dom.setChecked": "keyboard", "dom.setRadio": "keyboard",
      "forms.fill": "keyboard", form: "keyboard",
      // Screenshots.
      "screenshots.viewport": "camera", "screenshots.visible": "camera",
      "screenshots.element": "camera", "screenshots.fullPage": "camera",
      "browser.captureTab": "camera",
      // Scroll.
      "dom.scroll": "mouse", "dom.scrollTo": "mouse",
      // Navigation.
      "tabs.navigate": "nav-arrow", "tabs.create": "nav-arrow", "tabs.reload": "nav-arrow",
      "navigation.open": "nav-arrow", "navigation.back": "nav-arrow",
      "navigation.forward": "nav-arrow", "navigation.reload": "nav-arrow",
      "navigation.search": "nav-arrow", "navigation.wait": "nav-arrow",
      navigate: "nav-arrow", "workflows.openSequence": "nav-arrow",
      "workflows.restoreSession": "nav-arrow",
      // Drag.
      "dom.drag": "drag", "dom.dragAt": "drag",
      // Read / observe.
      "dom.find": "eye", "dom.read": "eye", "dom.boundingBox": "eye",
      "dom.visible": "eye", "dom.shadow": "eye", "page.read": "eye",
      "page.metadata": "eye", "page.outline": "eye", "page.links": "eye",
      "page.selectedText": "eye", "page.find": "eye", "page.extract": "eye",
      "page.tables": "eye", "page.snapshot": "eye", "page.accessibilityTree": "eye",
      "page.networkIdle": "eye", "page.waitFor": "eye", "page.dialogs": "eye",
      "page.respondDialog": "eye", observe: "eye", "frames.list": "eye",
      "forms.inspect": "eye", "forms.preview": "eye",
      // Tab and window management.
      "tabs.list": "tab", "tabs.active": "tab", "tabs.get": "tab",
      "tabs.search": "tab", "tabs.activate": "tab", "tabs.close": "tab",
      "tabs.group": "tab", "tabs.ungroup": "tab", "tabs.move": "tab",
      "tabs.pin": "tab", "tabs.mute": "tab", "tabs.setZoom": "tab",
      "tabs.discard": "tab", "tabs.duplicate": "tab",
      "windows.list": "tab", "windows.create": "tab", "windows.update": "tab",
      "windows.close": "tab", tabs: "tab", windows: "tab",
      // Submit / upload.
      "dom.submit": "send", "forms.submit": "send", submit: "send",
      "forms.upload": "upload", "forms.setFile": "upload",
      // Files and data.
      "files.list": "folder", "files.stat": "folder", files: "folder", data: "folder",
      // Bookmarks.
      "bookmarks.list": "bookmark", "bookmarks.search": "bookmark",
      "bookmarks.create": "bookmark", "bookmarks.update": "bookmark",
      "bookmarks.delete": "bookmark", "bookmarks.move": "bookmark",
      "bookmarks.createFolder": "bookmark",
      // History.
      "history.add": "history-rewind", "history.search": "history-rewind",
      "history.delete": "history-rewind",
      // Downloads.
      "downloads.list": "download", "downloads.control": "download",
      "downloads.start": "download", "downloads.erase": "download",
      // Clipboard.
      "clipboard.read": "clipboard", "clipboard.write": "clipboard",
      clipboard: "clipboard",
      // Browser info / diagnostics.
      "browser.info": "info", "browser.capabilities": "info",
      "browser.permissions": "info", "browser.activeContext": "info",
      "browser.diagnostics": "info", "browser.observer": "info",
      "browser.search": "info", browser: "info",
      // Devtools.
      "devtools.network": "wrench", "devtools.dom": "wrench",
      "devtools.performance": "wrench", "devtools.pageErrors": "wrench",
      "devtools.console": "wrench", devtools: "wrench",
      // Workflows.
      "workflows.summarizePage": "flow", "workflows.compareTabs": "flow",
      "workflows.extractTable": "flow", "workflows.collectLinks": "flow",
      "workflows.fillFormForReview": "flow", "workflows.organizeTabs": "flow",
      "workflows.saveSession": "flow", "workflows.researchReport": "flow",
      // Waits.
      "dom.waitFor": "clock", wait: "clock",
      // Task management.
      "tasks.create": "checklist", "tasks.complete": "checklist",
      "tasks.get": "checklist",
      "tasks.list": "checklist", "tasks.pause": "checklist",
      "tasks.resume": "checklist", "tasks.cancel": "checklist",
    };
    // The table must cover the registry exactly: a future tool added to
    // the registry without a family mapping fails here, not silently.
    expect(Object.keys(expected).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [tool, icon] of Object.entries(expected)) {
      expect(timelineIconForStep(tool, "running")).toBe(icon);
    }
  });
});
