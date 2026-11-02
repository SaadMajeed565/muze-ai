import type { CdpCapability } from "../libs/browser-engine/index.js";
import { ToolErrorException } from "../libs/tool-contracts/index.js";

const CDP_VERSION = "1.3";

/**
 * Bound for one CDP input sequence (unchanged from the 2026-10-28 bound:
 * raising it was explicitly rejected as a fix). The retest3 evidence
 * (live-test-2026-10-28-retest3.md) narrows the stall further: in the
 * same session, dom.clickAt, the act click step and dom.setChecked-check
 * PASS via CDP, while dom.click, dom.hover, dom.moveTo, dom.dragAt,
 * dom.setRadio and dom.setChecked-uncheck hit this 15s bound. The
 * passing and failing paths share attach → command → detach, and the
 * failing handlers differ from clickAt only in ways that cannot stall a
 * sendCommand on their own — so the sequence below was changed, not the
 * bound. The command-stream difference that does distinguish them is
 * position tracking: a first mouse sequence on a tab teleports with a
 * single mouseMoved, while every later sequence on that tab interpolated
 * from the tracked position in 6 mouseMoved steps, crossing every
 * intermediate element (hover menus, suggestion overlays) on the way.
 * That matches the pass/fail split exactly — check passes as the first
 * mouse sequence on its tab, uncheck fails as the second; clickAt
 * passes as the first mouse sequence on the wiki tab, later wiki mouse
 * calls fail — so interpolation is removed: every move is now the
 * single mouseMoved a first move always was. Sequences are also
 * serialised per tab (below): the old refcount only guarded detach,
 * so a timed-out sequence's commands and its capped detach could
 * interleave with the next sequence on the same tab and stall that one
 * too. Live verification is still required: no live browser is touched
 * by this change's tests (mocked debugger only).
 */
const CDP_SEQUENCE_TIMEOUT_MS = 15_000;
const CDP_DETACH_TIMEOUT_MS = 2_000;

/**
 * Enterprise hardware-level interaction via Chrome DevTools Protocol (CDP).
 *
 * Dispatches genuine hardware input events (`isTrusted: true`), which bypasses
 * synthetic-event restrictions on React 18/19 controlled inputs, native HTML5
 * form controls, file pickers, and anti-bot verification turnstiles.
 *
 * DETACH RULE (v0.3.0): a tab must not stay debugger-attached indefinitely.
 * A lingering attachment shows Chrome's debugger banner, blocks the user
 * from using DevTools on that tab, and keeps a privileged channel open with
 * no work in flight. So every input sequence and every screenshot detaches
 * when it finishes — UNLESS another CDP call for the same tab is still in
 * flight, in which case the last one out detaches (reference-counted per
 * tab, so concurrent sequences cannot detach each other mid-input).
 * Detach also happens on tab close / external detach (listeners below).
 *
 * Trade-off, stated plainly: detaching after every call costs one
 * `debugger.attach` round trip on the next call to that tab, versus the old
 * behaviour of attaching once and never letting go. Attach is cheap and
 * local; a lingering debugger banner and an open privileged channel are
 * not, so the re-attach cost is the right side of that trade.
 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ChromeCdpCapability implements CdpCapability {
  private readonly attachedTabs = new Set<number>();
  private readonly attachingPromises = new Map<number, Promise<void>>();
  /** Per-tab serialisation chain: every withTab sequence for a tab runs
   * only after the previous sequence for that tab has finished AND
   * detached. The old refcount let two sequences overlap (it only kept
   * the last one out from detaching); overlapping sequences interleave
   * their dispatchMouseEvent streams, and a timed-out sequence's detach
   * could land mid-input on the next sequence. The stored chain promise
   * never rejects, so one failed sequence can never wedge later ones. */
  private readonly queues = new Map<number, Promise<void>>();
  /** Last genuine mouse position per tab, recorded for bookkeeping.
   * It is deliberately NOT used to interpolate any more (see the header
   * comment): every move is a single mouseMoved to its target, exactly
   * like a first move. It is cleared on a sequence timeout, because a
   * timed-out sequence leaves the true cursor position unknown. */
  private readonly lastMouse = new Map<number, { x: number; y: number }>();
  /** Per-tab sequence generation, bumped when a sequence times out.
   * A timed-out fn() promise keeps running after withTab's race has
   * settled and its detach has run; without this guard its late
   * sendCommand calls would dispatch into the NEXT sequence's attached
   * session on the same tab. Every in-sequence command goes through
   * send(), which refuses to dispatch once the generation has moved
   * on, so a late command fails the orphaned sequence instead of
   * interleaving with its successor. Normal (non-timed-out) sequences
   * never see a generation change and are unaffected. */
  private readonly generations = new Map<number, number>();

  constructor() {
    if (typeof chrome !== "undefined") {
      if (chrome.debugger?.onDetach) {
        chrome.debugger.onDetach.addListener((source) => {
          if (source.tabId) this.attachedTabs.delete(source.tabId);
        });
      }
      if (chrome.tabs?.onRemoved) {
        chrome.tabs.onRemoved.addListener((tabId) => {
          this.attachedTabs.delete(tabId);
          this.lastMouse.delete(tabId);
          this.generations.delete(tabId);
        });
      }
    }
  }

  available(): boolean {
    return typeof chrome !== "undefined" && Boolean(chrome.debugger?.attach);
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    const existing = this.attachingPromises.get(tabId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
        this.attachedTabs.add(tabId);
      } catch (error) {
        // Tab might already have a debugger attached
        if (/Already attached/i.test(String(error))) {
          this.attachedTabs.add(tabId);
          return;
        }
        throw error;
      }
    })().finally(() => {
      this.attachingPromises.delete(tabId);
    });

    this.attachingPromises.set(tabId, promise);
    return promise;
  }

  /** Run one CDP sequence, serialised per tab, detaching afterwards.
   * Detach is awaited inside the serialised section (capped, see detach):
   * the old code raced detach against a 2s timer and returned while a
   * detach was still in flight, so the next sequence could skip attach
   * (attachedTabs still set) and send commands into a detaching session.
   * On a sequence timeout the tracked position is cleared, so a retry
   * starts from a clean state instead of interpolating from a position
   * the timed-out sequence may never have reached. */
  /** Dispatch one CDP command for the running sequence, or refuse it
   * when the sequence has already timed out (see generations). Attach,
   * detach, and out-of-sequence calls never go through here. */
  private async send(tabId: number, generation: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    // A tab with no entry yet is generation 0: get() returns undefined,
    // which must compare equal to a fresh sequence's generation, or
    // every first sequence on a tab would be refused.
    if ((this.generations.get(tabId) ?? 0) !== generation) {
      throw new ToolErrorException("CANCELLED", "CDP sequence superseded after its timeout; late commands are not dispatched");
    }
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  private async withTab<T>(tabId: number, fn: (generation: number) => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const run = previous.then(async (): Promise<T> => {
      await this.ensureAttached(tabId);
      const generation = this.generations.get(tabId) ?? 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        // The orphaned fn()'s late rejection must never surface as an
        // unhandled rejection after the race has settled on TIMEOUT:
        // the no-op catch marks it handled; the race below still
        // observes the same promise and decides the outcome.
        const fnPromise = fn(generation);
        fnPromise.catch(() => undefined);
        return await Promise.race([
          fnPromise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              // Bump before rejecting: any command the orphaned fn()
              // still tries to send after this point is refused by
              // send() instead of landing in the next sequence.
              this.generations.set(tabId, generation + 1);
              reject(
                new ToolErrorException(
                  "TIMEOUT",
                  `CDP input sequence did not complete within ${CDP_SEQUENCE_TIMEOUT_MS}ms (debugger attach or a command stalled). Detach was attempted; retry once, and if it repeats, check whether another debugger or DevTools session is attached to the tab.`,
                ),
              );
            }, CDP_SEQUENCE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (timedOut) this.lastMouse.delete(tabId);
        // Detach must not itself hang the call, but it must complete
        // (or be force-cleared) before the next queued sequence starts.
        await this.detach(tabId).catch(() => undefined);
      }
    });
    // The chain itself never rejects: a failed sequence must not wedge
    // every later sequence queued behind it.
    this.queues.set(tabId, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  }

  /** Move the genuine cursor to a point with a single mouseMoved event.
   * Must run inside withTab. The old version interpolated from the last
   * tracked position in 6 steps when one was known; that stepped stream
   * is the one command-stream difference between the retest3 passing
   * first mouse sequences and the failing later ones (see header), and
   * it also drags the cursor across every intermediate element, whose
   * hover handlers can re-render the page mid-sequence. A single move
   * is what a first move — and the passing clickAt path — always did. */
  private async moveInside(tabId: number, x: number, y: number, generation: number): Promise<void> {
    await this.send(tabId, generation, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x),
      y: Math.round(y),
      buttons: 0,
    });
    this.lastMouse.set(tabId, { x, y });
  }

  async move(tabId: number, x: number, y: number): Promise<void> {
    await this.withTab(tabId, async (generation) => {
      await this.moveInside(tabId, x, y, generation);
    });
  }

  async click(tabId: number, x: number, y: number, button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
    await this.withTab(tabId, async (generation) => {
      const cdpButton = button === "right" ? "right" : button === "middle" ? "middle" : "left";

      // Travel -> hover dwell -> press -> hold -> release. The old version
      // sent move/press/release back to back with no timing, which is a
      // recognisably non-human sequence even though every event isTrusted.
      await this.moveInside(tabId, x, y, generation);
      await delay(50);
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(x),
        y: Math.round(y),
        button: cdpButton,
        buttons: cdpButton === "left" ? 1 : cdpButton === "right" ? 2 : 4,
        clickCount,
      });
      await delay(60);
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(x),
        y: Math.round(y),
        button: cdpButton,
        buttons: 0,
        clickCount,
      });
      this.lastMouse.set(tabId, { x, y });
    });
  }

  async type(tabId: number, text: string): Promise<void> {
    await this.withTab(tabId, async (generation) => {
      // Input.insertText dispatches trusted input directly to the focused element
      await this.send(tabId, generation, "Input.insertText", { text });
    });
  }

  async press(tabId: number, key: string, modifiers = 0): Promise<void> {
    await this.withTab(tabId, async (generation) => {
      await this.send(tabId, generation, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        modifiers,
        windowsVirtualKeyCode: getKeyCode(key),
      });
      // A printable character with no modifiers must also produce a char
      // event: rawKeyDown + keyUp alone inserts nothing in editors that
      // listen for text input, and a named key must never be reduced to
      // its first letter's code (see getKeyCode). Modifier chords
      // (Ctrl+A etc.) and non-printable keys get no char event.
      if (modifiers === 0 && key.length === 1 && key >= " " && key !== "\x7f") {
        await this.send(tabId, generation, "Input.dispatchKeyEvent", {
          type: "char",
          key,
          text: key,
          unmodifiedText: key,
          modifiers,
          windowsVirtualKeyCode: getKeyCode(key),
        });
      }
      await this.send(tabId, generation, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        modifiers,
        windowsVirtualKeyCode: getKeyCode(key),
      });
    });
  }

  async scroll(tabId: number, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.withTab(tabId, async (generation) => {
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(x),
        y: Math.round(y),
        deltaX: Math.round(deltaX),
        deltaY: Math.round(deltaY),
      });
    });
  }

  async drag(tabId: number, fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
    await this.withTab(tabId, async (generation) => {
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(fromX),
        y: Math.round(fromY),
        buttons: 0,
      });
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(fromX),
        y: Math.round(fromY),
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      // Retest4 drag finding: drag was the LAST remaining interpolated
      // path. The retest3 fix removed interpolation from moveInside
      // (every move is a single mouseMoved, like a first move), and
      // click/hover/moveTo/setRadio/setChecked then passed as second
      // sequences — but drag still sent 5 interpolated mouseMoved
      // events with buttons:1, and drag/dragAt still hit the 15s bound
      // on fresh refs, with no stale-ref error. A pressed-button move
      // stream is exactly the stream a renderer turns into a native
      // drag: each interpolated step can start/extend a native
      // drag session, re-render hover targets, or select text, and a
      // sendCommand inside that drag session can stall until the
      // drag ends — which never happens while more moves keep coming.
      // So drag now mirrors the passing click path: one single
      // mouseMoved straight to the destination, with longer settles
      // (100ms) after press and before release so a dragstart, if the
      // page starts one, finishes dispatching before the next event.
      // The 15s bound is unchanged. If this CDP stream still stalls
      // on a page, the dom.drag/dom.dragAt handlers fall back to the
      // synthetic page-agent drag (DragEvent dispatch) on TIMEOUT
      // only — see tools/interact.ts — rather than failing outright.
      await delay(100);
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(toX),
        y: Math.round(toY),
        buttons: 1,
      });
      await delay(100);
      await this.send(tabId, generation, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(toX),
        y: Math.round(toY),
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      this.lastMouse.set(tabId, { x: toX, y: toY });
    });
  }

  async captureScreenshot(
    tabId: number,
    clip?: { x: number; y: number; width: number; height: number; scale?: number },
    format: "jpeg" | "png" = "jpeg",
    quality = 60,
  ): Promise<string> {
    return this.withTab(tabId, async (generation) => {
      const params: Record<string, unknown> = {
        format,
        ...(format === "jpeg" ? { quality } : {}),
        fromSurface: true,
        captureBeyondViewport: false,
      };
      if (clip) {
        params.clip = { ...clip, scale: clip.scale ?? 1 };
      }
      const result = (await this.send(tabId, generation, "Page.captureScreenshot", params)) as { data: string };
      return `data:image/${format};base64,${result.data}`;
    });
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    try {
      // Capped, but the attached mark is cleared even if the detach
      // itself hangs: the old version awaited detach unconditionally in
      // its finally, so a hung detach left attachedTabs set and the next
      // sequence skipped attach and sent commands into a detaching
      // session. A late detach resolving afterwards is idempotent.
      await Promise.race([
        chrome.debugger.detach({ tabId }),
        new Promise<void>((resolve) => setTimeout(resolve, CDP_DETACH_TIMEOUT_MS)),
      ]);
    } catch {
      // ignore
    } finally {
      this.attachedTabs.delete(tabId);
    }
  }
}

function getKeyCode(key: string): number {
  // Named keys must map to their real virtual-key codes. The old
  // default (key.charCodeAt(0)) turned "F5" into 70 ("F"), "Control"
  // into 67 ("C"), and "Shift" into 83 ("S") — the wrong key entirely.
  // Single printable characters still fall through to charCodeAt(0);
  // anything unlisted and multi-character maps to 0 rather than to a
  // misleading letter code.
  switch (key) {
    case "Enter": return 13;
    case "Backspace": return 8;
    case "Tab": return 9;
    case "Escape": return 27;
    case " ": return 32;
    case "PageUp": return 33;
    case "PageDown": return 34;
    case "End": return 35;
    case "Home": return 36;
    case "ArrowLeft": return 37;
    case "ArrowUp": return 38;
    case "ArrowRight": return 39;
    case "ArrowDown": return 40;
    case "Insert": return 45;
    case "Delete": return 46;
    case "Control": return 17;
    case "Shift": return 16;
    case "Alt": return 18;
    case "Meta": return 91;
    case "CapsLock": return 20;
    case "NumLock": return 144;
    case "ScrollLock": return 145;
    case "F1": return 112;
    case "F2": return 113;
    case "F3": return 114;
    case "F4": return 115;
    case "F5": return 116;
    case "F6": return 117;
    case "F7": return 118;
    case "F8": return 119;
    case "F9": return 120;
    case "F10": return 121;
    case "F11": return 122;
    case "F12": return 123;
    default: return key.length === 1 ? key.charCodeAt(0) : 0;
  }
}
