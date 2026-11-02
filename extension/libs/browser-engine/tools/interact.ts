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
  domPressAt,
  domRead,
  domScroll,
  domScrollTo,
  domSelect,
  domSetChecked,
  domSetRadio,
  domShadow,
  domSubmit,
  domType,
  domTypeAt,
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
import { assertViewportCoords, isCdpAvailable, isTopFrameCdp, mapScreenshotCoords, parseFrameRef, requireScriptableTab, runPageOp, settlePage } from "./helpers.js";
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

/** Genuine CDP click at an element's centre, in any frame: topViewportBox
 * maps a sub-frame element to top-viewport coordinates (CDP input is
 * tab-level, in top-viewport pixels). Returns false for a cross-origin
 * sub-frame, where the offset cannot be computed — the caller must fall
 * back to synthetic input rather than click at a wrong point. Used by
 * the click, toggle, and submit handlers, which are clicks by another
 * name. */
async function cdpClickElement(
  ctx: BrowserContext,
  tabId: number,
  ref: string,
  frameId: number | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const box = await runPageOp<{ viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean }>(
    ctx, tabId, { op: "topViewportBox", ref }, frameId, signal,
  );
  if (box.crossOrigin) return false;
  await ctx.cdp!.click(tabId, box.viewportX + box.width / 2, box.viewportY + box.height / 2, "left");
  return true;
}

/** Genuine CDP clear: focus, select all with Ctrl+A, then Backspace.
 * A DOM setter clear is not a user gesture; this is. */
async function cdpClearField(ctx: BrowserContext, tabId: number, ref: string, frameId: number | undefined, signal: AbortSignal): Promise<void> {
  await runPageOp(ctx, tabId, { op: "focus", ref }, frameId, signal);
  await ctx.cdp!.press(tabId, "a", 2);
  await ctx.cdp!.press(tabId, "Backspace", 0);
}

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

/** Focused-element read-back for the coordinate typing path (see
 * dom.typeAt): what the browser actually has focused, and what text it
 * holds. The value/text is used only for the landed check inside the
 * handler and is never returned to the caller. */
type FocusedValue = { tagName: string; visible: boolean; value?: string; textContent?: string };

async function readFocusedValue(
  ctx: BrowserContext,
  tabId: number,
  frameId: number | undefined,
  signal: AbortSignal,
): Promise<FocusedValue> {
  return runPageOp<FocusedValue>(ctx, tabId, { op: "focusedValue" }, frameId, signal);
}

function focusedText(focused: FocusedValue): string | null {
  if (typeof focused.value === "string") return focused.value;
  if (typeof focused.textContent === "string") return focused.textContent;
  return null;
}

/**
 * Visibility gate for CDP input paths (Gmail recipient-editor failure
 * mode: the recipient editor resolves to a 0x0 hidden input, focus()
 * succeeds on it, CDP insertText goes nowhere, yet the tool reported
 * typed:true/filled:true). The gate runs on the CDP path only, before
 * any focus/CDP input, and fails fast with a "target is hidden" error.
 * The synthetic page-agent paths are not gated: those ops write into
 * the element itself (value setter / dispatched input events), so a
 * synthetic success is a real write, not a false one — and a blanket
 * gate would false-positive wherever geometry is unavailable (jsdom
 * reports a 0-size rect for every element). dom.click's CDP path is
 * gated the same way: a hidden element's box centre is (0,0), so an
 * ungated CDP click would click the viewport's top-left corner.
 */
async function requireVisibleTarget(
  ctx: BrowserContext,
  tabId: number,
  ref: string,
  frameId: number | undefined,
  signal: AbortSignal,
): Promise<void> {
  const seen = await runPageOp<{ visible: boolean }>(ctx, tabId, { op: "visible", ref }, frameId, signal);
  if (!seen.visible) {
    throw new ToolErrorException(
      "INVALID_INPUT",
      `target ${ref} is hidden (0x0, display:none, visibility:hidden, or opacity:0); CDP input to a hidden element goes nowhere, so this fails fast instead of reporting success — re-observe and use the visible target instead`,
    );
  }
}

/**
 * Coordinate typing preparation, shared by dom.typeAt/dom.pressAt: map
 * and bounds-check the point, activation-check it, click it (CDP when
 * top-frame CDP is available, synthetic otherwise), then focus the
 * element at that point — a synthetic mousedown does not move focus,
 * so the synthetic path needs an explicit focusAt — and fail fast when
 * what ended up focused is hidden. CDP input after this goes to the
 * actually focused element with NO refocus to any hidden element.
 */
async function prepareCoordinateTarget(
  exec: { ctx: BrowserContext; approvalValidated: boolean; signal: AbortSignal },
  tabId: number,
  data: { frameId?: number; x: number; y: number; coordinateSpace?: "css" | "screenshot"; key?: string },
  mapped: { x: number; y: number },
): Promise<FocusedValue> {
  await requireActivationApproval(exec, tabId, { op: "activationCheck", x: mapped.x, y: mapped.y, key: data.key }, data.frameId);
  if (isTopFrameCdp(exec.ctx, data.frameId)) {
    await exec.ctx.cdp!.click(tabId, mapped.x, mapped.y, "left", 1);
  } else {
    await runPageOp<{ clicked: true }>(exec.ctx, tabId, { op: "clickAt", x: mapped.x, y: mapped.y }, data.frameId, exec.signal);
  }
  await runPageOp(exec.ctx, tabId, { op: "focusAt", x: mapped.x, y: mapped.y }, data.frameId, exec.signal);
  const focused = await readFocusedValue(exec.ctx, tabId, data.frameId, exec.signal);
  if (!focused.visible) {
    throw new ToolErrorException(
      "INVALID_INPUT",
      `target is hidden: the element at (${mapped.x}, ${mapped.y}) resolved to a hidden element (${focused.tagName}); CDP input to it would go nowhere — click the visible target instead`,
    );
  }
  return focused;
}
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
    // CDP click in any frame: topViewportBox maps the element to
    // top-viewport coordinates, which is what CDP input uses. The
    // synthetic path runs when CDP is unavailable, for a cross-origin
    // sub-frame whose offset cannot be computed, or — aligned with the
    // dom.drag/dom.dragAt policy — when a CDP click stalls to TIMEOUT
    // only. Any other CDP failure is thrown explicitly and never hidden
    // behind a synthetic fallback, and the fallback honestly reports
    // method: "synthetic".
    if (isCdpAvailable(exec.ctx)) {
      // Fail fast on a hidden target: its box centre is (0,0), so an
      // ungated CDP click would click the viewport's top-left corner.
      await requireVisibleTarget(exec.ctx, tab.id!, data.ref, data.frameId, exec.signal);
      const box = await runPageOp<{ viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean }>(
        exec.ctx, tab.id!, { op: "topViewportBox", ref: data.ref }, data.frameId, exec.signal,
      );
      if (!box.crossOrigin) {
        try {
          await exec.ctx.cdp!.click(tab.id!, box.viewportX + box.width / 2, box.viewportY + box.height / 2, data.button);
          await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
          return { clicked: true as const, ref: data.ref, hardware: true, method: "cdp" as const };
        } catch (error) {
          if (!(ToolErrorException.is(error) && error.code === "TIMEOUT")) throw error;
        }
      }
    }
    const result = await runPageOp(exec.ctx, tab.id!, { op: "click", ref: data.ref, button: data.button }, data.frameId, exec.signal);
    await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
    return { ...(result as Record<string, unknown>), method: "synthetic" as const };
  }),

  // dom.focus stays on the browser focus API: CDP has no focus input
  // command, and focusing by clicking would activate the element, while
  // focusing by Tabbing is index-dependent and fragile. Focus is a
  // prerequisite, not a gesture sites check for isTrusted, and every
  // CDP type/press/fill that follows a focus already goes through CDP.
  defineTool(domFocus, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    return runPageOp(ctx, tab.id!, { op: "focus", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domHover, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isCdpAvailable(ctx)) {
      const box = await runPageOp<{ viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean }>(
        ctx, tab.id!, { op: "topViewportBox", ref: data.ref }, data.frameId, signal,
      );
      if (!box.crossOrigin) {
        await ctx.cdp!.move(tab.id!, box.viewportX + box.width / 2, box.viewportY + box.height / 2);
        // dom.hover's strict output schema has no method/hardware fields, so
        // the CDP path returns the same shape as the synthetic path.
        return { hovered: true as const, ref: data.ref };
      }
    }
    return runPageOp(ctx, tab.id!, { op: "hover", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domScroll, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; direction: "up" | "down" | "top" | "bottom"; amount: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isTopFrameCdp(ctx, data.frameId)) {
      // Genuine wheel scroll at the viewport centre. Top/bottom use a
      // large delta and let the browser clamp at the page ends; the
      // returned scroll state is read back, not set by script.
      const vp = await runPageOp<{ width: number; height: number }>(ctx, tab.id!, { op: "getViewport" }, data.frameId, signal);
      const deltaY = data.direction === "up" ? -data.amount : data.direction === "down" ? data.amount : data.direction === "top" ? -100_000 : 100_000;
      await ctx.cdp!.scroll(tab.id!, Math.round(vp.width / 2), Math.round(vp.height / 2), 0, deltaY);
      return runPageOp(ctx, tab.id!, { op: "scrollState" }, data.frameId, signal);
    }
    return runPageOp(ctx, tab.id!, { op: "scrollPage", direction: data.direction, amount: data.amount }, data.frameId, signal);
  }),

  defineTool(domScrollTo, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isCdpAvailable(ctx)) {
      // Scroll into view with a genuine wheel, not scrollIntoView:
      // measure without moving (topBox), wheel toward the viewport
      // centre, re-measure, repeat. If the element is inside a container
      // the wheel cannot move, or its frame is cross-origin, fall back
      // to scrollIntoView rather than leave it off-screen.
      const vp = await runPageOp<{ width: number; height: number }>(ctx, tab.id!, { op: "getViewport" }, undefined, signal);
      let inView = false;
      for (let i = 0; i < 20; i++) {
        const box = await runPageOp<{ viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean }>(
          ctx, tab.id!, { op: "topBox", ref: data.ref }, data.frameId, signal,
        );
        if (box.crossOrigin) break;
        const centreY = box.viewportY + box.height / 2;
        const centreX = box.viewportX + box.width / 2;
        if (centreY >= 0 && centreY <= vp.height && centreX >= 0 && centreX <= vp.width) {
          inView = true;
          break;
        }
        const deltaY = Math.max(-2000, Math.min(2000, Math.round(centreY - vp.height / 2)));
        if (deltaY === 0) break;
        await ctx.cdp!.scroll(tab.id!, Math.round(vp.width / 2), Math.round(vp.height / 2), 0, deltaY);
      }
      if (inView) return { scrolled: true as const, ref: data.ref };
    }
    return runPageOp(ctx, tab.id!, { op: "scrollTo", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domSelect, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; value?: string; label?: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    // Normalise before any lookup: an empty value is a missing value,
    // not a value to match (upstream callers send value:"" for a
    // label-only select). Without this, "" shadows the label in every
    // lookup below and in the page agent, which is exactly how the
    // retest3 label call ("Three", value left at "2") returned
    // selected:false: the lookup matched nothing and never tried the
    // label. The page agent applies the same rule, so this is belt and
    // braces at the handler boundary, not the only place it is fixed.
    const value = data.value !== undefined && data.value !== "" ? data.value : undefined;
    const label = data.label !== undefined && data.label !== "" ? data.label : undefined;
    if (isCdpAvailable(ctx)) {
      // CDP has no select command, so a select is driven the way a user
      // drives it: focus it, then step through options with real arrow
      // keys, then verify the value actually changed. Multiple selects
      // keep the DOM path, because arrow-key stepping cannot express
      // them. An unfindable option NO LONGER returns selected:false
      // here: it falls through to the DOM path, whose lookup (visible
      // text, value-miss fallback to label) is the authority on whether
      // the option exists — the old short-circuit returned false for a
      // label the stepping lookup had not matched, without ever trying
      // the DOM lookup.
      const before = await runPageOp<{ selectedIndex: number; optionIndex: number; value: string; multiple: boolean; notSelect?: boolean; tagName?: string }>(
        ctx, tab.id!, { op: "selectIndex", ref: data.ref, value, label }, data.frameId, signal,
      );
      if (before.notSelect) {
        throw new ToolErrorException(
          "INVALID_INPUT",
          `dom.select only works on a <select> element, but ref ${data.ref} is a <${(before.tagName ?? "unknown").toLowerCase()}> element. Use dom.fill/dom.type for text inputs, or find a <select> element first.`,
        );
      }
      if (!before.multiple && before.optionIndex >= 0 && before.optionIndex !== before.selectedIndex) {
        await runPageOp(ctx, tab.id!, { op: "focus", ref: data.ref }, data.frameId, signal);
        const key = before.optionIndex > before.selectedIndex ? "ArrowDown" : "ArrowUp";
        const steps = Math.abs(before.optionIndex - before.selectedIndex);
        for (let i = 0; i < steps; i++) await ctx.cdp!.press(tab.id!, key, 0);
        const after = await runPageOp<{ selectedIndex: number; optionIndex: number; value: string }>(
          ctx, tab.id!, { op: "selectIndex", ref: data.ref, value, label }, data.frameId, signal,
        );
        if (after.optionIndex >= 0 && after.selectedIndex === after.optionIndex) {
          return { selected: true as const, value: after.value };
        }
        // Keyboard stepping did not land on the option (custom widget,
        // listbox, or a popup that swallowed the keys): fall through to
        // the DOM path below rather than report a wrong selection.
      } else if (!before.multiple && before.optionIndex >= 0 && before.optionIndex === before.selectedIndex) {
        return { selected: true as const, value: before.value };
      }
      // optionIndex < 0, or a multiple select, or stepping missed:
      // fall through to the DOM path below.
    }
    return runPageOp(ctx, tab.id!, { op: "select", ref: data.ref, value, label }, data.frameId, signal);
  }),

  defineTool(domSetChecked, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; checked: boolean };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isCdpAvailable(ctx)) {
      // A toggle is a click: only click when the state actually differs,
      // exactly like the synthetic path, then read the state back. A
      // cross-origin sub-frame falls through to the synthetic path.
      // Note (retest3): check and uncheck take this SAME branch — there
      // is no uncheck-only code path to fix. The observed check-pass /
      // uncheck-timeout split is the CDP mouse sequence split (uncheck
      // was the second mouse sequence on its tab, so it took the old
      // interpolated move); see cdp-controller.ts.
      const before = await runPageOp<{ checked: boolean }>(ctx, tab.id!, { op: "checkedState", ref: data.ref }, data.frameId, signal);
      if (before.checked !== data.checked) {
        const clicked = await cdpClickElement(ctx, tab.id!, data.ref, data.frameId, signal);
        if (!clicked) return runPageOp(ctx, tab.id!, { op: "setChecked", ref: data.ref, checked: data.checked }, data.frameId, signal);
      }
      return runPageOp(ctx, tab.id!, { op: "checkedState", ref: data.ref }, data.frameId, signal);
    }
    return runPageOp(ctx, tab.id!, { op: "setChecked", ref: data.ref, checked: data.checked }, data.frameId, signal);
  }),

  defineTool(domSetRadio, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isCdpAvailable(ctx)) {
      const clicked = await cdpClickElement(ctx, tab.id!, data.ref, data.frameId, signal);
      if (clicked) return runPageOp(ctx, tab.id!, { op: "checkedState", ref: data.ref }, data.frameId, signal);
    }
    return runPageOp(ctx, tab.id!, { op: "setRadio", ref: data.ref }, data.frameId, signal);
  }),

  defineTool(domFill, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; value: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await assertNotSensitiveField(ctx, tab.id!, data.ref, data.frameId, signal);
    if (isCdpAvailable(ctx)) {
      // Fill as a genuine user would: clear with real keys, then type
      // with trusted CDP insertText, instead of setting the value by
      // script and firing untrusted input/change events. CDP text goes
      // to the focused element, in any frame, so this is not top-frame
      // only. Gated: focusing a hidden element then typing into it
      // reports filled:true while nothing lands (see requireVisibleTarget).
      await requireVisibleTarget(ctx, tab.id!, data.ref, data.frameId, signal);
      await cdpClearField(ctx, tab.id!, data.ref, data.frameId, signal);
      if (data.value) await ctx.cdp!.type(tab.id!, data.value);
      return { filled: true as const, ref: data.ref };
    }
    return runPageOp(ctx, tab.id!, { op: "setValue", ref: data.ref, value: data.value }, data.frameId, signal);
  }),

  defineTool(domClear, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isCdpAvailable(ctx)) {
      await cdpClearField(ctx, tab.id!, data.ref, data.frameId, signal);
      return { cleared: true as const, ref: data.ref };
    }
    await runPageOp(ctx, tab.id!, { op: "clear", ref: data.ref }, data.frameId, signal);
    return { cleared: true as const, ref: data.ref };
  }),

  defineTool(domType, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; ref: string; text: string; waitMs?: number; waitForNetworkIdle?: boolean };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    await assertNotSensitiveField(ctx, tab.id!, data.ref, data.frameId, signal);
    if (isCdpAvailable(ctx)) {
      // Gated before focus: CDP insertText to a hidden element's focus
      // goes nowhere while the old code still returned typed:true.
      await requireVisibleTarget(ctx, tab.id!, data.ref, data.frameId, signal);
    }
    await runPageOp(ctx, tab.id!, { op: "focus", ref: data.ref }, data.frameId, signal);
    if (isCdpAvailable(ctx)) {
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
    if (isCdpAvailable(exec.ctx)) {
      // Focus first, as the synthetic path does: CDP key events go to
      // the focused element, in any frame, so without this a press could
      // land on whatever happened to be focused before. Gated before
      // focus: key events to a hidden element do nothing while the old
      // code still returned pressed:true.
      await requireVisibleTarget(exec.ctx, tab.id!, data.ref, data.frameId, exec.signal);
      await runPageOp(exec.ctx, tab.id!, { op: "focus", ref: data.ref }, data.frameId, exec.signal);
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

  defineTool(domTypeAt, async (input, exec) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      x: number;
      y: number;
      coordinateSpace?: "css" | "screenshot";
      text: string;
      waitMs?: number;
      waitForNetworkIdle?: boolean;
    };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const mapped = await mapScreenshotCoords(exec.ctx, tab.id!, data.x, data.y, data.coordinateSpace, data.frameId, exec.signal);
    await assertViewportCoords(exec.ctx, tab.id!, [mapped], data.frameId, exec.signal);
    // Coordinate typing path (Gmail recipient-editor failure mode):
    // click the VISIBLE target, then send CDP input to the element
    // that is actually focused — never refocusing a hidden element by
    // ref. The typed text is verified in the focused element afterwards;
    // a miss is an error, never typed:true.
    await prepareCoordinateTarget(exec, tab.id!, data, mapped);
    const verifyLanded = async (): Promise<boolean> => {
      if (data.text === "") return true;
      const after = await readFocusedValue(exec.ctx, tab.id!, data.frameId, exec.signal);
      const text = focusedText(after);
      return text !== null && text.includes(data.text);
    };
    if (isCdpAvailable(exec.ctx)) {
      await exec.ctx.cdp!.type(tab.id!, data.text);
      if (await verifyLanded()) {
        await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
        return { typed: true as const, x: mapped.x, y: mapped.y, hardware: true, method: "cdp" as const };
      }
      // CDP verification failed: synthetic per-character fallback into
      // the still-focused element (no refocus to any hidden element).
      await runPageOp(exec.ctx, tab.id!, { op: "typeFocused", text: data.text }, data.frameId, exec.signal);
      if (await verifyLanded()) {
        await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
        return { typed: true as const, x: mapped.x, y: mapped.y, method: "synthetic" as const };
      }
      throw new ToolErrorException(
        "INTERNAL",
        `dom.typeAt: typed text did not land in the element focused at (${mapped.x}, ${mapped.y}) via CDP or the synthetic fallback; nothing is reported as typed`,
      );
    }
    await runPageOp(exec.ctx, tab.id!, { op: "typeFocused", text: data.text }, data.frameId, exec.signal);
    if (await verifyLanded()) {
      await settlePage(exec.ctx, tab.id!, data, data.frameId, exec.signal);
      return { typed: true as const, x: mapped.x, y: mapped.y, method: "synthetic" as const };
    }
    throw new ToolErrorException(
      "INTERNAL",
      `dom.typeAt: typed text did not land in the element focused at (${mapped.x}, ${mapped.y}); nothing is reported as typed`,
    );
  }),

  defineTool(domPressAt, async (input, exec) => {
    const data = input as {
      tabId?: number;
      frameId?: number;
      x: number;
      y: number;
      coordinateSpace?: "css" | "screenshot";
      key: string;
      modifiers: ("Control" | "Shift" | "Alt" | "Meta")[];
    };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    const mapped = await mapScreenshotCoords(exec.ctx, tab.id!, data.x, data.y, data.coordinateSpace, data.frameId, exec.signal);
    await assertViewportCoords(exec.ctx, tab.id!, [mapped], data.frameId, exec.signal);
    // Same coordinate path as dom.typeAt: click the visible target,
    // fail fast if what ends up focused is hidden, then press without
    // refocusing. A press has no text to verify landing, so the
    // focused-visible check in prepareCoordinateTarget is the guard.
    await prepareCoordinateTarget(exec, tab.id!, data, mapped);
    if (isCdpAvailable(exec.ctx)) {
      let bitmask = 0;
      if (data.modifiers?.includes("Alt")) bitmask |= 1;
      if (data.modifiers?.includes("Control")) bitmask |= 2;
      if (data.modifiers?.includes("Meta")) bitmask |= 4;
      if (data.modifiers?.includes("Shift")) bitmask |= 8;
      await exec.ctx.cdp!.press(tab.id!, data.key, bitmask);
      return { pressed: true as const, x: mapped.x, y: mapped.y, key: data.key, hardware: true, method: "cdp" as const };
    }
    await runPageOp(exec.ctx, tab.id!, { op: "pressFocused", key: data.key, modifiers: data.modifiers }, data.frameId, exec.signal);
    return { pressed: true as const, x: mapped.x, y: mapped.y, key: data.key, method: "synthetic" as const };
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
    if (isTopFrameCdp(ctx, data.frameId)) {
      await ctx.cdp!.move(tab.id!, data.x, data.y);
      return { moved: true as const, x: data.x, y: data.y, method: "cdp" as const };
    }
    await runPageOp<{ moved: true }>(ctx, tab.id!, { op: "moveTo", x: data.x, y: data.y }, data.frameId, signal);
    return { moved: true as const, x: data.x, y: data.y, method: "synthetic" as const };
  }),

  defineTool(domDrag, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; frameId?: number; fromRef: string; toRef: string };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (isCdpAvailable(ctx)) {
      // Both boxes in ONE page op (topViewportBoxes): the old code
      // measured from and to in two separate ops, and each
      // topViewportBox scrolls its element into view, so the from
      // coordinates were measured in a different scroll state than the
      // to coordinates, and a ref replaced between the two calls failed
      // as a bare STALE_ELEMENT naming neither ref. A stale ref is
      // still never silently re-resolved to a different element: it
      // fails here, naming exactly which ref went stale, and the
      // caller re-observes to get a fresh ref and retries. That
      // caller-side re-observe requirement is unchanged and is the
      // only remedy for a genuinely replaced element (e.g. Wikipedia's
      // search component replacing its input on re-render).
      type Box = { viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean; stale?: false } | { stale: true };
      const { boxes } = await runPageOp<{ boxes: Box[] }>(
        ctx, tab.id!, { op: "topViewportBoxes", refs: [data.fromRef, data.toRef] }, data.frameId, signal,
      );
      const staleIndex = boxes.findIndex((b) => (b as { stale?: boolean }).stale);
      if (staleIndex >= 0) {
        const staleRef = staleIndex === 0 ? data.fromRef : data.toRef;
        throw new ToolErrorException(
          "STALE_ELEMENT",
          `dom.drag: ${staleIndex === 0 ? "fromRef" : "toRef"} ${staleRef} is stale (its element was replaced or removed after it was observed) — re-observe to get a fresh ref, then retry. Refs are never silently re-resolved to a different element.`,
        );
      }
      const [from, to] = boxes as { viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean }[];
      if (!from.crossOrigin && !to.crossOrigin) {
        let cdpTimedOut = false;
        try {
          await ctx.cdp!.drag(tab.id!, from.viewportX + from.width / 2, from.viewportY + from.height / 2, to.viewportX + to.width / 2, to.viewportY + to.height / 2);
        } catch (error) {
          // Retest4: CDP drag still stalls (15s TIMEOUT) on pages where
          // click/hover/moveTo pass, i.e. the drag stream itself, not
          // the mouse path in general. A timed-out CDP drag leaves no
          // usable drag behind, and the synthetic page-agent drag
          // (DragEvent dragstart/dragover/drop) is the established
          // fallback for pages without CDP — so on TIMEOUT only, run
          // it for real below instead of failing outright. Other
          // errors (stale refs, validation, restricted pages) are
          // rethrown: they are not drag-stream stalls and must not
          // be masked. dom.drag's strict output schema has no method
          // field, so the fallback is not advertised in the result;
          // this comment is the record of it.
          if (!(ToolErrorException.is(error) && error.code === "TIMEOUT")) throw error;
          cdpTimedOut = true;
        }
        if (cdpTimedOut) {
          await runPageOp<{ dragged: true }>(ctx, tab.id!, { op: "drag", fromRef: data.fromRef, toRef: data.toRef }, data.frameId, signal);
        }
        // dom.drag's strict output schema has no method/hardware fields.
        return { dragged: true as const, fromRef: data.fromRef, toRef: data.toRef };
      }
    }
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
    if (isTopFrameCdp(ctx, data.frameId)) {
      try {
        await ctx.cdp!.drag(tab.id!, from.x, from.y, to.x, to.y);
        return { dragged: true as const, x1: from.x, y1: from.y, x2: to.x, y2: to.y, method: "cdp" as const };
      } catch (error) {
        // Same TIMEOUT-only synthetic fallback as dom.drag above:
        // a stalled CDP drag stream must not mask other failures, and
        // the result honestly reports method "synthetic" when the
        // fallback ran, never "cdp".
        if (!(ToolErrorException.is(error) && error.code === "TIMEOUT")) throw error;
      }
      await runPageOp<{ dragged: true }>(ctx, tab.id!, { op: "dragAt", x1: from.x, y1: from.y, x2: to.x, y2: to.y }, data.frameId, signal);
      return { dragged: true as const, x1: from.x, y1: from.y, x2: to.x, y2: to.y, method: "synthetic" as const };
    }
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
    if (isCdpAvailable(ctx)) {
      // Only a submit button/input is a click. A form itself is submitted
      // by the browser's requestSubmit API, not by clicking its centre,
      // which could hit a child control instead — so forms keep the
      // native-API path, which is a trusted browser call, not a JS event.
      const desc = await runPageOp<{
        element?: { tagName?: string; type?: string };
      }>(ctx, tab.id!, { op: "elementDescriptor", ref: data.ref }, data.frameId, signal);
      const isSubmitControl =
        desc.element?.tagName === "button" ||
        (desc.element?.tagName === "input" && (desc.element.type === "submit" || desc.element.type === "image"));
      if (isSubmitControl) {
        const clicked = await cdpClickElement(ctx, tab.id!, data.ref, data.frameId, signal);
        if (clicked) return { submitted: true as const, ref: data.ref, dispatched: true as const, verified: false as const };
      }
    }
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
    const data = input as { tabId?: number; frameId?: number; selector?: string; ref?: string; fileId?: string; files?: Array<{ name: string; mimeType: string; dataBase64: string }> };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    if (!data.selector && !data.ref) {
      throw new ToolErrorException("INVALID_INPUT", "Either selector or ref must be provided");
    }
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
    // Selector wins when both are given (previous behaviour); a ref-only
    // call resolves through the page agent's exact ref registry, never by
    // feeding the opaque ref string to querySelector (which matches
    // nothing and misreports a live element as STALE_ELEMENT).
    if (data.selector) {
      return runPageOp(ctx, tab.id!, { op: "setFile", selector: data.selector, files }, data.frameId, signal);
    }
    return runPageOp(ctx, tab.id!, { op: "setFileByRef", ref: data.ref!, files }, data.frameId, signal);
  }),

  defineTool(formsFill, async (input, exec) => {
    const data = input as { tabId?: number; frameId?: number; fields: { ref: string; value: string }[] };
    const tab = await requireScriptableTab(exec.ctx, data.tabId, exec.signal);
    if (isCdpAvailable(exec.ctx)) {
      // Batch form fill via the same genuine paths as the granular tools:
      // text fields go through dom.fill (CDP keys + insertText), selects
      // through dom.select, toggles are skipped as before. A single bad
      // field must not abort the batch, so per-field failures are
      // reported in `skipped`, matching the synthetic fillForm report.
      const filled: { ref: string; field: string; value: string }[] = [];
      const skipped: { field: string; reason: string }[] = [];
      for (const field of data.fields) {
        try {
          const desc = await runPageOp<{
            element?: { tagName?: string; type?: string };
            label?: string;
          }>(exec.ctx, tab.id!, { op: "elementDescriptor", ref: field.ref }, data.frameId, exec.signal);
          if (!desc.element) {
            skipped.push({ field: field.ref, reason: "stale or missing element" });
            continue;
          }
          const label = desc.label || field.ref;
          if (desc.element.tagName === "input" && (desc.element.type === "checkbox" || desc.element.type === "radio")) {
            skipped.push({ field: label, reason: "use dom.setChecked/setRadio for toggles" });
            continue;
          }
          if (desc.element.tagName === "select") {
            const sel = await exec.invoke<{ selected: boolean }>("dom.select", { tabId: tab.id, frameId: data.frameId, ref: field.ref, value: field.value });
            if (sel.selected) filled.push({ ref: field.ref, field: label, value: "•".repeat(Math.min(field.value.length, 8)) });
            else skipped.push({ field: label, reason: "option not found" });
            continue;
          }
          await exec.invoke("dom.fill", { tabId: tab.id, frameId: data.frameId, ref: field.ref, value: field.value });
          filled.push({ ref: field.ref, field: label, value: "•".repeat(Math.min(field.value.length, 8)) });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "PERMISSION_DENIED") skipped.push({ field: field.ref, reason: "sensitive field is never filled" });
          else if (code === "STALE_ELEMENT" || /STALE_ELEMENT/.test(error instanceof Error ? error.message : String(error))) {
            // Deliberately NOT re-resolved: a stale ref after a reload or
            // navigation must not silently bind to a different element.
            // The caller re-observes to get a fresh ref and retries.
            skipped.push({ field: field.ref, reason: "stale ref after a reload/navigation — re-observe to get a fresh ref, then retry (refs are never silently re-resolved to a different element)" });
          } else skipped.push({ field: field.ref, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
        }
      }
      return { filled, skipped };
    }
    return runPageOp(exec.ctx, tab.id!, { op: "fillForm", fields: data.fields }, data.frameId, exec.signal);
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
    if (ctx.cdp?.available() && ctx.cdp.captureScreenshot) {
      // One capture path for active and background tabs alike. The old
      // code used CDP (no clip, whole-surface capture) only for
      // background tabs and chrome.tabs.captureVisibleTab + an offscreen
      // decode round-trip for active tabs, so the same call was fast on
      // one tab and hung to the 30s executor limit on another — the
      // page-dependent visible timeout. The CDP viewport clip is the
      // same path screenshots.element already uses successfully: it
      // needs no tab activation and no offscreen decode. Only a CDP
      // TIMEOUT falls back to the tabs capture (a background tab whose
      // surface is not painting stalls CDP, but the tabs capture
      // activates the tab and usually succeeds); any other CDP failure
      // is thrown explicitly rather than silently masked.
      try {
        const vp = await runPageOp<{ width: number; height: number; devicePixelRatio: number }>(ctx, tab.id!, { op: "getViewport" }, undefined, signal).catch(() => ({ width: 1280, height: 800, devicePixelRatio: 1 }));
        const dpr = vp.devicePixelRatio > 0 ? vp.devicePixelRatio : 1;
        const dataUrl = await ctx.cdp.captureScreenshot(
          tab.id!,
          { x: 0, y: 0, width: Math.max(1, vp.width), height: Math.max(1, vp.height), scale: dpr },
          data.format,
          data.quality,
        );
        return { dataUrl, format: data.format, width: Math.round(vp.width * dpr), height: Math.round(vp.height * dpr) };
      } catch (error) {
        const isTimeout = ToolErrorException.is(error) ? error.code === "TIMEOUT" : /did not complete within/i.test(error instanceof Error ? error.message : String(error));
        if (!isTimeout) throw error;
      }
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
    return {
      dataUrl: shot.dataUrl,
      format: data.format,
      width: shot.width,
      height: shot.height,
      pages: shot.pages,
      ...(shot.partial ? { partial: true as const, partialReason: shot.partialReason ?? "Captured height was capped; the image covers only the top of the page" } : {}),
    };
  }),

  defineTool(screenshotsViewport, async (input, { ctx, signal }) => {
    const data = input as { tabId?: number; format: "png" | "jpeg"; quality: number };
    const tab = await requireScriptableTab(ctx, data.tabId, signal);
    // A screenshots.* tool must return a screenshot: the old handler
    // returned only getViewport dimensions despite the name. Capture
    // via the same CDP viewport-clip path as screenshots.visible
    // (falling back to the tabs capture), and keep the dimensions in
    // the result. Observe's internal viewport read no longer goes
    // through this tool (it uses a direct getViewport page op), so
    // making this capture no longer turns every observe into a
    // screenshot or an approval error.
    const vp = await runPageOp<{ width: number; height: number; devicePixelRatio: number; scrollY: number }>(
      ctx, tab.id!, { op: "getViewport" }, undefined, signal,
    );
    if (ctx.cdp?.available() && ctx.cdp.captureScreenshot) {
      try {
        const dpr = vp.devicePixelRatio > 0 ? vp.devicePixelRatio : 1;
        const dataUrl = await ctx.cdp.captureScreenshot(
          tab.id!,
          { x: 0, y: 0, width: Math.max(1, vp.width), height: Math.max(1, vp.height), scale: dpr },
          data.format,
          data.quality,
        );
        return { dataUrl, format: data.format, width: vp.width, height: vp.height, devicePixelRatio: vp.devicePixelRatio, scrollY: vp.scrollY };
      } catch (error) {
        const isTimeout = ToolErrorException.is(error) ? error.code === "TIMEOUT" : /did not complete within/i.test(error instanceof Error ? error.message : String(error));
        if (!isTimeout) throw error;
      }
    }
    const shot = await ctx.captureVisibleTab(tab.id!, { format: data.format, quality: data.quality });
    return { dataUrl: shot.dataUrl, format: data.format, width: vp.width, height: vp.height, devicePixelRatio: vp.devicePixelRatio, scrollY: vp.scrollY };
  }),
];
