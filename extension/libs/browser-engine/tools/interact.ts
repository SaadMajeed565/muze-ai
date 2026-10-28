import {
  domBoundingBox,
  domClear,
  domClick,
  domClickAt,
  domDrag,
  domDragAt,
  domFill,
  domFind,
  domFocus,
  domHover,
  domMoveTo,
  domPress,
  domRead,
  domScroll,
  domScrollTo,
  domSelect,
  domSetChecked,
  domSetRadio,
  domShadow,
  domSubmit,
  domType,
  domVisible,
  domWaitFor,
  formsFill,
  formsInspect,
  formsPreview,
  formsSetFile,
  formsSubmit,
  formsUpload,
  screenshotsElement,
  screenshotsFullPage,
  screenshotsViewport,
  screenshotsVisible,
  ToolErrorException,
} from "../../tool-contracts/index.js";
import type { BrowserContext } from "../context.js";
import { getFile } from "../../files/index.js";
import { defineTool, type RegisteredTool } from "../registry.js";
import { assertViewportCoords, isTopFrameCdp, mapScreenshotCoords, parseFrameRef, requireScriptableTab, runPageOp, settlePage } from "./helpers.js";
import { isSensitiveElement, isSensitiveFieldName } from "../../security/privacy.js";

async function requireActivationApproval(
  exec: { ctx: BrowserContext; approvalValidated: boolean; signal: AbortSignal },
  tabId: number,
  check: { op: "activationCheck"; ref?: string; x?: number; y?: number; key?: string },
  frameId: number | undefined,
): Promise<void> {
  const activation = await runPageOp<{ consequential: boolean; reason: string; tagName?: string; text?: string }>(
    exec.ctx,
    tabId,
    check,
    frameId,
    exec.signal,
  );
  if (!activation.consequential || exec.approvalValidated) return;
  throw new ToolErrorException(
    "APPROVAL_REQUIRED",
    `This action would ${activation.reason === "download" ? "start a download" : "submit a form"}; approve it explicitly`,
    { details: { reason: activation.reason, tagName: activation.tagName, text: activation.text } },
  );
}

async function getFileFromStore(id: string): Promise<{ name: string; mimeType: string; dataBase64: string } | null> {
  const file = await getFile(id);
  if (!file) return null;
  const bytes = new Uint8Array(file.data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const dataBase64 = btoa(binary);
  return { name: file.name, mimeType: file.mimeType, dataBase64 };
}

type FindParams = { tabId?: number; frameId?: number; by: string; value: string; role?: string; name?: string; limit: number };

/**
 * Handler-level sensitive-field guard, using the same detection as forms.fill
 * (type, name, id, aria-label, visible label, autocomplete). dom.fill and
 * dom.type refuse a credential field outright instead of writing into it.
 */
async function assertNotSensitiveField(
  ctx: BrowserContext,
  tabId: number,
  ref: string,
  frameId: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  const desc = await runPageOp<{
    element?: { tagName?: string; type?: string; name?: string; id?: string; autocomplete?: string; ariaLabel?: string; metaName?: string };
    label?: string;
  }>(ctx, tabId, { op: "elementDescriptor", ref }, frameId, signal);
  if (desc.element && (isSensitiveElement(desc.element) || isSensitiveFieldName(desc.label))) {
    throw new ToolErrorException("PERMISSION_DENIED", "Refusing to write into a sensitive (credential) field");
  }
}

const UPLOAD_BASE64_LIMIT = 15_000_000;
const SET_FILE_BASE64_LIMIT = 35_000_000;

/** Inline-file caps matching the granular handlers, stated in characters. */
function assertInlineFileCaps(files: { dataBase64: string }[], perFileLimit: number, totalLimit: number, tool: string): void {
  for (const file of files) {
    if (file.dataBase64.length > perFileLimit) {
      throw new ToolErrorException("INVALID_INPUT", `A file for ${tool} exceeds the ${perFileLimit.toLocaleString("en-US")} base64 character limit`);
    }
  }
  const total = files.reduce((sum, file) => sum + file.dataBase64.length, 0);
  if (total > totalLimit) {
    throw new ToolErrorException("INVALID_INPUT", `The files for ${tool} exceed the ${totalLimit.toLocaleString("en-US")} base64 character limit`);
  }
}

export const interactToolHandlers: RegisteredTool[] = [
  defineTool(domFind, async (input, { ctx, signal }) => {
    const data = input as FindParams;
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "findElements", by: data.by as never, value: data.value, role: data.role, name: data.name, limit: data.limit }, data.frameId, signal);
  }),

  defineTool(domRead, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; attributes: string[] };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "readElement", ref: data.ref, attributes: data.attributes }, data.frameId, signal);
  }),

  defineTool(domClick, async (input, exec) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      ref: string;
      button: "left" | "right" | "middle";
      waitMs?: number;
      waitForNetworkIdle?: boolean;
    };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    if (data.button === "left") {
      await requireActivationApproval(exec, tab.id!, { op: "activationCheck", ref: data.ref }, data.frameId);
    }
    // CDP fast paths are top-frame only. When CDP is available, a CDP failure
    // is thrown explicitly — it is never silently hidden behind a synthetic
    // fallback. The synthetic path runs only when CDP is unavailable (or the
    // frame is a sub-frame) and records method: "synthetic".
    if (isTopFrameCdp(exec.ctx, data.frameId)) {
      const box = await runPageOp<{ viewportX: number; viewportY: number; width: number; height: number }>(
        exec.ctx,
        tab.id!,
        { op: "boundingBox", ref: data.ref },
        data.frameId,
        exec.signal,
      );
      await exec.ctx.cdp!.click(tab.id!, box.viewportX + box.width / 2, box.viewportY + box.height / 2, data.button);
      await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
      return { clicked: true as const, ref: data.ref, hardware: true, method: "cdp" as const };
    }
    const result = await runPageOp(exec.ctx, tab.id!, { op: "click", ref: data.ref, button: data.button }, data.frameId, exec.signal);
    await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
    return { ...(result as Record<string, unknown>), method: "synthetic" as const };
  }),

  defineTool(domFocus, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "focus", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domHover, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "hover", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domScroll, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; direction: "up" | "down" | "top" | "bottom"; amount: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "scrollPage", direction: data.direction, amount: data.amount }, data.frameId, signal);
  }),

  defineTool(domScrollTo, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "scrollTo", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domSelect, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; value?: string; label?: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "select", ref: data.ref, value: data.value, label: data.label }, data.frameId, signal);
  }),

  defineTool(domSetChecked, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; checked: boolean };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "setChecked", ref: data.ref, checked: data.checked }, data.frameId, signal);
  }),

  defineTool(domSetRadio, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "setRadio", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domFill, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; value: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await assertNotSensitiveField(ctx, tab.id!, data.ref, data.frameId, signal);
    return runPageOp(ctx, tab.id!, { op: "setValue", ref: data.ref, value: data.value }, data.frameId, signal);
  }),

  defineTool(domClear, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await runPageOp(ctx, tab.id!, { op: "clear", ref: data.ref }, data.frameId, signal);
    return { cleared: true as const, ref: data.ref };
  }),

  defineTool(domType, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; text: string; waitMs?: number; waitForNetworkIdle?: boolean };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await assertNotSensitiveField(ctx, tab.id!, data.ref, data.frameId, signal);
    await runPageOp(ctx, tab.id!, { op: "focus", ref: data.ref }, data.frameId, signal);
    if (isTopFrameCdp(ctx, data.frameId)) {
      await ctx.cdp!.type(tab.id!, data.text);
      await settlePage(ctx, tab.id!, data, data.frameId, signal);
      return { typed: true as const, ref: data.ref, hardware: true, method: "cdp" as const };
    }
    await runPageOp<{ typed: true }>(ctx, tab.id!, { op: "type", ref: data.ref, text: data.text }, data.frameId, signal);
    await settlePage(ctx, tab.id!, data, data.frameId, signal);
    return { typed: true as const, ref: data.ref, method: "synthetic" as const };
  }),

  defineTool(domPress, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; key: string; modifiers: ("Control" | "Shift" | "Alt" | "Meta")[] };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    if (data.key === "Enter" || data.key === " ") {
      await requireActivationApproval(exec, tab.id!, { op: "activationCheck", ref: data.ref, key: data.key }, data.frameId);
    }
    if (isTopFrameCdp(exec.ctx, data.frameId)) {
      let bitmask = 0;
      if (data.modifiers?.includes("Alt")) bitmask |= 1;
      if (data.modifiers?.includes("Control")) bitmask |= 2;
      if (data.modifiers?.includes("Meta")) bitmask |= 4;
      if (data.modifiers?.includes("Shift")) bitmask |= 8;
      await exec.ctx.cdp!.press(tab.id!, data.key, bitmask);
      return { pressed: true as const, ref: data.ref, hardware: true, method: "cdp" as const };
    }
    await runPageOp<{ pressed: true }>(exec.ctx, tab.id!, { op: "press", ref: data.ref, key: data.key, modifiers: data.modifiers }, data.frameId, exec.signal);
    return { pressed: true as const, ref: data.ref, method: "synthetic" as const };
  }),

  defineTool(domClickAt, async (input, exec) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      x: number;
      y: number;
      coordinateSpace?: "css" | "screenshot";
      waitMs?: number;
      waitForNetworkIdle?: boolean;
    };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const mapped = await mapScreenshotCoords(exec.ctx, tab.id!, data.x, data.y, data.coordinateSpace, data.frameId, exec.signal);
    await assertViewportCoords(exec.ctx, tab.id!, [mapped], data.frameId, exec.signal);
    await requireActivationApproval(exec, tab.id!, { op: "activationCheck", x: mapped.x, y: mapped.y }, data.frameId);
    if (isTopFrameCdp(exec.ctx, data.frameId)) {
      await exec.ctx.cdp!.click(tab.id!, mapped.x, mapped.y, "left", 1);
      await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
      return { clicked: true as const, x: mapped.x, y: mapped.y, hardware: true, method: "cdp" as const };
    }
    const result = await runPageOp<{ clicked: true; x: number; y: number; tagName?: string }>(
      exec.ctx,
      tab.id!,
      { op: "clickAt", x: mapped.x, y: mapped.y },
      data.frameId,
      exec.signal,
    );
    await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
    return { clicked: true as const, x: result.x, y: result.y, tagName: result.tagName, method: "synthetic" as const };
  }),

  defineTool(domMoveTo, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; x: number; y: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await assertViewportCoords(ctx, tab.id!, [{ x: data.x, y: data.y }], data.frameId, signal);
    await runPageOp<{ moved: true }>(ctx, tab.id!, { op: "moveTo", x: data.x, y: data.y }, data.frameId, signal);
    return { moved: true as const, x: data.x, y: data.y, method: "synthetic" as const };
  }),

  defineTool(domDrag, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; fromRef: string; toRef: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await runPageOp<{ dragged: true }>(ctx, tab.id!, { op: "drag", fromRef: data.fromRef, toRef: data.toRef }, data.frameId, signal);
    return { dragged: true as const, fromRef: data.fromRef, toRef: data.toRef };
  }),

  defineTool(domDragAt, async (input, { ctx, signal }) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      coordinateSpace?: "css" | "screenshot";
    };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const from = await mapScreenshotCoords(ctx, tab.id!, data.x1, data.y1, data.coordinateSpace, data.frameId, signal);
    const to = await mapScreenshotCoords(ctx, tab.id!, data.x2, data.y2, data.coordinateSpace, data.frameId, signal);
    await assertViewportCoords(ctx, tab.id!, [from, to], data.frameId, signal);
    await runPageOp<{ dragged: true }>(ctx, tab.id!, { op: "dragAt", x1: from.x, y1: from.y, x2: to.x, y2: to.y }, data.frameId, signal);
    return { dragged: true as const, x1: from.x, y1: from.y, x2: to.x, y2: to.y, method: "synthetic" as const };
  }),

  defineTool(domBoundingBox, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp<{ x: number; y: number; viewportX: number; viewportY: number; width: number; height: number }>(
      ctx,
      tab.id!,
      { op: "boundingBox", ref: data.ref },
      data.frameId,
      signal,
    );
  }),

  defineTool(domVisible, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp<{ visible: boolean; occluded?: boolean }>(ctx, tab.id!, { op: "visible", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domShadow, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; maxDepth: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "shadowRoots", maxDepth: data.maxDepth }, data.frameId, signal);
  }),

  defineTool(domSubmit, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; expectedAction?: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const result = await runPageOp<{ submitted: boolean; dispatched?: boolean; verified?: boolean }>(
      ctx, tab.id!, { op: "submit", ref: data.ref, expectedAction: data.expectedAction }, data.frameId, signal,
    );
    // dispatched, not verified: no navigation or result is observed here.
    return { submitted: true as const, ref: data.ref, dispatched: result.dispatched ?? true, verified: false as const };
  }),

  defineTool(domWaitFor, async (input, { ctx, signal }) => {
    const data = input as FindParams & { timeoutMs: number; visible: boolean };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, {
      op: "waitForElement",
      by: data.by as never,
      value: data.value,
      role: data.role,
      name: data.name,
      timeoutMs: data.timeoutMs,
      visible: data.visible,
    }, data.frameId, signal);
  }),

  defineTool(formsInspect, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "inspectForms" }, data.frameId, signal);
  }),

  defineTool(formsPreview, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp<{ fields: { ref: string; label: string; type: string; required: boolean; options?: string[] }[] }>(
      ctx,
      tab.id!,
      { op: "previewForm", ref: data.ref },
      data.frameId,
      signal,
    );
  }),

  defineTool(formsSetFile, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; selector: string; fileId?: string; files?: Array<{ name: string; mimeType: string; dataBase64: string }> };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (!data.fileId && (!data.files || data.files.length === 0)) {
      throw new ToolErrorException("INVALID_INPUT", "Either fileId or files must be provided");
    }
    let files = data.files ?? [];
    if (data.fileId) {
      const file = await getFileFromStore(data.fileId);
      if (!file) throw new ToolErrorException("NOT_FOUND", "File not found in store");
      files = [file];
    }
    // Inline files only: the store path carries no inline base64. The cap
    // matches the granular contract (35,000,000 base64 characters per file).
    if (!data.fileId) assertInlineFileCaps(files, SET_FILE_BASE64_LIMIT, SET_FILE_BASE64_LIMIT, "forms.setFile");
    return runPageOp(ctx, tab.id!, { op: "setFile", selector: data.selector, files }, data.frameId, signal);
  }),

  defineTool(formsFill, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; fields: { ref: string; value: string }[] };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "fillForm", fields: data.fields }, data.frameId, signal);
  }),

  defineTool(formsSubmit, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; formRef: string; expectedAction?: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    const result = await runPageOp<{ submitted: boolean; dispatched?: boolean; verified?: boolean }>(ctx, tab.id!, { op: "submit", ref: data.formRef, expectedAction: data.expectedAction }, data.frameId, signal);
    // The submission was dispatched, not verified: this handler returns
    // immediately without observing a navigation or a result, so verified
    // is false and the evidence string says so explicitly.
    return {
      submitted: true as const,
      formRef: data.formRef,
      dispatched: result.dispatched ?? result.submitted,
      verified: false as const,
      evidence: "form submission dispatched (not verified: no navigation or result was observed)",
    };
  }),

  defineTool(screenshotsVisible, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; format: "png" | "jpeg"; quality: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (!tab.active && ctx.cdp?.available() && ctx.cdp.captureScreenshot) {
      // CDP is available here, so a capture failure is thrown explicitly
      // rather than silently falling back to captureVisibleTab.
      const dataUrl = await ctx.cdp.captureScreenshot(tab.id!, undefined, data.format, data.quality);
      const vp = await runPageOp<{ width: number; height: number }>(ctx, tab.id!, { op: "getViewport" }, undefined, signal).catch(() => ({ width: 1280, height: 800 }));
      return { dataUrl, format: data.format, width: vp.width, height: vp.height };
    }
    const shot = await ctx.captureVisibleTab(tab.id!, { format: data.format, quality: data.quality });
    return { dataUrl: shot.dataUrl, format: data.format, width: shot.width, height: shot.height };
  }),

  defineTool(screenshotsElement, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (!ctx.captureElement && !ctx.cdp?.available()) {
      throw new ToolErrorException("UNSUPPORTED", "Element screenshot cropping is not available in this build");
    }
    if (parseFrameRef(data.ref).frameId > 0) {
      throw new ToolErrorException("UNSUPPORTED", "Element screenshots of iframe content are not supported; capture the viewport instead");
    }
    const rect = await runPageOp<{ x: number; y: number; width: number; height: number }>(ctx, tab.id!, { op: "elementRect", ref: data.ref }, data.frameId, signal);
    if (ctx.cdp?.available() && ctx.cdp.captureScreenshot && (!data.frameId || data.frameId === 0)) {
      // CDP is available here, so a capture failure is thrown explicitly
      // rather than silently falling back to the offscreen canvas.
      const dataUrl = await ctx.cdp.captureScreenshot(tab.id!, {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
        scale: 1,
      }, "png");
      return { dataUrl, width: rect.width, height: rect.height };
    }
    if (!ctx.captureElement) {
      throw new ToolErrorException("UNSUPPORTED", "Element screenshot cropping is not available in this build");
    }
    const shot = await ctx.captureElement(tab.id!, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, { format: "png" });
    return { dataUrl: shot.dataUrl, width: shot.width, height: shot.height };
  }),

  defineTool(formsUpload, async (input, { ctx, signal }) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      ref: string;
      files: { name: string; mimeType: string; dataBase64: string }[];
    };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    // The file content is carried inline; it never leaves the browser.
    // Caps are stated in base64 characters, matching the granular contract:
    // 15,000,000 per file and 15,000,000 in total (not a mismatched MB figure).
    assertInlineFileCaps(data.files, UPLOAD_BASE64_LIMIT, UPLOAD_BASE64_LIMIT, "forms.upload");
    const result = await runPageOp<{ uploaded: number; names: string[] }>(
      ctx,
      tab.id!,
      { op: "uploadFiles", ref: data.ref, files: data.files },
      data.frameId,
      signal,
    );
    return { uploaded: result.uploaded, names: result.names };
  }),


  defineTool(screenshotsFullPage, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; maxHeight: number; format: "png" | "jpeg"; quality: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (!ctx.captureFullPage) {
      throw new ToolErrorException("UNSUPPORTED", "Full page capture is not available in this build");
    }
    const shot = await ctx.captureFullPage(tab.id!, {
      format: data.format,
      quality: data.quality,
      maxHeight: data.maxHeight,
    });
    return { dataUrl: shot.dataUrl, format: data.format, width: shot.width, height: shot.height, pages: shot.pages };
  }),

  defineTool(screenshotsViewport, async (input, { ctx, signal }) => {
    const tab = await requireScriptableTab(ctx, (input as { tabId?: number }).tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "getViewport" }, undefined, signal);
  }),
];
