/**
 * A single, self-contained function injected into pages via
 * chrome.scripting.executeScript({ func }). It must not reference anything from
 * module scope: Chrome serializes it with Function.prototype.toString().
 *
 * All DOM access for the page.*, dom.*, forms.*, screenshots.* and devtools.*
 * tools funnels through this dispatcher so there is exactly one content-script
 * surface to audit.
 */

export type PageOp =
  | { op: "readPage"; offset: number; maxChars: number }
  | { op: "readClipboard" }
  | { op: "writeClipboard"; text: string }
  | { op: "metadata" }
  | { op: "outline"; maxDepth: number }
  | { op: "links"; limit: number; sameOriginOnly: boolean }
  | { op: "selected" }
  | { op: "findText"; query: string; caseSensitive: boolean; limit: number; contextChars: number }
  | { op: "tables"; index?: number; maxRows: number }
  | { op: "findElements"; by: FindBy; value: string; role?: string; name?: string; limit: number }
  | { op: "readElement"; ref: string; attributes: string[] }
  | { op: "click"; ref: string; button: "left" | "right" | "middle" }
  | { op: "activationCheck"; ref?: string; x?: number; y?: number; key?: string }
  | { op: "focus"; ref: string }
  | { op: "focusAt"; x: number; y: number }
  | { op: "focusedValue" }
  | { op: "typeFocused"; text: string }
  | { op: "pressFocused"; key: string; modifiers: ("Control" | "Shift" | "Alt" | "Meta")[] }
  | { op: "hover"; ref: string }
  | { op: "scrollPage"; direction: "up" | "down" | "top" | "bottom"; amount: number }
  | { op: "scrollTo"; ref: string }
  | { op: "scrollToXY"; x: number; y: number }
  | { op: "elementDescriptor"; ref: string }
  | { op: "select"; ref: string; value?: string; label?: string }
  | { op: "setChecked"; ref: string; checked: boolean }
  | { op: "setRadio"; ref: string }
  | { op: "checkedState"; ref: string }
  | { op: "scrollState" }
  | { op: "topViewportBox"; ref: string }
  | { op: "topViewportBoxes"; refs: string[] }
  | { op: "topBox"; ref: string }
  | { op: "selectIndex"; ref: string; value?: string; label?: string }
  | { op: "setValue"; ref: string; value: string }
  | { op: "clear"; ref: string }
  | { op: "submit"; ref: string; expectedAction?: string }
  | { op: "waitForElement"; by: FindBy; value: string; role?: string; name?: string; timeoutMs: number; visible: boolean }
  | { op: "inspectForms" }
  | { op: "fillForm"; fields: { ref: string; value: string }[] }
  | { op: "getViewport" }
  | { op: "elementRect"; ref: string }
  | { op: "domStructure"; maxNodes: number; maxDepth: number }
  | { op: "performance" }
  | { op: "type"; ref: string; text: string }
  | { op: "press"; ref: string; key: string; modifiers: ("Control" | "Shift" | "Alt" | "Meta")[] }
  | { op: "clickAt"; x: number; y: number }
  | { op: "moveTo"; x: number; y: number }
  | { op: "drag"; fromRef: string; toRef: string }
  | { op: "dragAt"; x1: number; y1: number; x2: number; y2: number }
  | { op: "boundingBox"; ref: string }
  | { op: "visible"; ref: string }
  | { op: "extractFields"; fields: { name: string; selector: string; attribute?: string }[] }
  | { op: "waitForSelector"; selector: string; timeoutMs: number }
  | { op: "previewForm"; ref: string }
  | { op: "setFile"; selector: string; files: { name: string; mimeType: string; dataBase64: string }[] }
  | { op: "setFileByRef"; ref: string; files: { name: string; mimeType: string; dataBase64: string }[] }
  | { op: "shadowRoots"; maxDepth: number }
  | { op: "a11yTree"; maxNodes: number; maxDepth: number; interactiveOnly: boolean }
  | { op: "snapshot"; maxNodes: number; maxDepth: number; interactiveOnly: boolean }
  | { op: "uploadFiles"; ref: string; files: { name: string; mimeType: string; dataBase64: string }[] }
  | { op: "networkIdle"; quietMs: number; timeoutMs: number }
  | { op: "pageMetrics" }
  | { op: "scrollToY"; y: number }
  | { op: "hideSticky"; hidden: boolean };

export type FindBy = "selector" | "text" | "label" | "placeholder" | "role" | "name";

export interface ElementSnapshot {
  ref: string;
  role?: string;
  name?: string;
  tagName: string;
  text?: string;
  selector?: string;
}

export interface FormFieldSnapshot {
  ref: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
}

export interface FormSnapshot {
  ref: string;
  action?: string;
  method?: string;
  fields: FormFieldSnapshot[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function pageAgent(request: PageOp): any {
  const doc = document;
  const store = globalThis as unknown as {
    __muzeRefElements?: Map<string, WeakRef<Element>>;
    __muzeElementRefs?: WeakMap<Element, string>;
  };
  store.__muzeRefElements ??= new Map();
  const refElements = store.__muzeRefElements;
  store.__muzeElementRefs ??= new WeakMap();
  const elementRefs = store.__muzeElementRefs;

  /** Attributes whose value is a live secret rather than page metadata. */
  const BLOCKED_ATTRIBUTES = new Set(["value", "srcdoc", "nonce", "defaultvalue"]);

  /** Meta tag names whose content is a credential rather than a description. */
  const SENSITIVE_META = /(csrf|xsrf|token|secret|nonce|session[_-]?id|api[_-]?key|authorization)/i;

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = (el as HTMLElement).getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Every element in the document, descending into open shadow roots so that
   * web-component based pages behave like ordinary markup.
   */
  function deepQueryAll(root: ParentNode = doc): Element[] {
    const out: Element[] = [];
    const walk = (node: ParentNode): void => {
      for (const el of Array.from(node.children)) {
        out.push(el);
        // Regular children first, then any open shadow root the element
        // hosts, so the result stays in document order.
        walk(el);
        const shadow = (el as Element).shadowRoot;
        if (shadow) walk(shadow);
      }
    };
    walk(root);
    return out;
  }

  /** Selector query that also matches inside open shadow roots. */
  function deepQuerySelectorAll(selector: string): Element[] {
    let matches: (el: Element) => boolean;
    try {
      doc.querySelectorAll(selector);
      matches = (el: Element) => el.matches(selector);
    } catch {
      return [];
    }
    return deepQueryAll().filter(matches);
  }

  /** getElementById, but across shadow roots. */
  function deepGetElementById(id: string): Element | null {
    const direct = doc.getElementById(id);
    if (direct) return direct;
    for (const el of deepQueryAll()) {
      if (el.id === id) return el;
    }
    return null;
  }

  /** Observe the document and every open shadow root, re-scanning as new hosts appear. */
  function observeDeep(observer: MutationObserver): void {
    if (doc.documentElement) {
      observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true });
    }
    for (const el of deepQueryAll()) {
      const shadow = (el as Element).shadowRoot;
      if (!shadow) continue;
      try {
        observer.observe(shadow, { subtree: true, childList: true, attributes: true });
      } catch {
        /* the shadow root was detached between the scan and the observe call */
      }
    }
  }

  /** The identifying attributes of an element, used to decide if it holds a secret. */
  function describeElement(el: Element): {
    tagName?: string;
    type?: string;
    name?: string;
    id?: string;
    autocomplete?: string;
    ariaLabel?: string;
    metaName?: string;
  } {
    const tag = el.tagName.toLowerCase();
    return {
      tagName: tag,
      type: el.getAttribute("type") ?? undefined,
      name: el.getAttribute("name") ?? undefined,
      id: el.getAttribute("id") ?? undefined,
      autocomplete: el.getAttribute("autocomplete") ?? undefined,
      ariaLabel: el.getAttribute("aria-label") ?? undefined,
      metaName: tag === "meta" ? (el.getAttribute("name") ?? el.getAttribute("property") ?? undefined) : undefined,
    };
  }

  /**
   * Credential-field detection inside the page. The page agent is serialized
   * and injected, so it cannot import the security module; these lists mirror
   * that module's tokens/phrases/autocomplete values and must be kept in
   * step with it. Checked against type, name, id, aria-label, visible label
   * text and autocomplete — not just a narrow type/name pattern.
   */
  const SENSITIVE_TOKENS = new Set([
    "password", "passwd", "pwd", "passphrase", "passcode", "secret", "credential", "credentials",
    "token", "otp", "cvv", "cvc", "csc", "cvv2", "cvc2", "ssn", "sin", "pin", "pincode",
    "iban", "swift", "bic", "apikey", "authtoken", "accesstoken", "refreshtoken", "sessionid",
    "secretkey", "privatekey", "card",
  ]);
  const SENSITIVE_PHRASES = [
    "credit card", "debit card", "card number", "card no", "one time code", "verification code",
    "security code", "auth code", "otp code", "pass code", "api key", "api secret", "access token",
    "refresh token", "auth token", "session id", "social security", "routing number", "sort code",
    "account number", "account no", "bank code", "security token", "secret token",
  ];
  const SENSITIVE_AUTOCOMPLETE = new Set([
    "current-password", "new-password", "one-time-code", "cc-name", "cc-number", "cc-csc",
    "cc-exp", "cc-exp-month", "cc-exp-year", "transaction-password",
  ]);
  function normalizeFieldName(raw: string): string {
    return raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function isSensitiveName(raw: string | null | undefined): boolean {
    if (!raw) return false;
    const normalized = normalizeFieldName(raw);
    if (!normalized) return false;
    if (SENSITIVE_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
    return normalized.split(" ").some((token) => SENSITIVE_TOKENS.has(token));
  }
  function isSensitiveField(el: Element): boolean {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase().trim();
    if (autocomplete && SENSITIVE_AUTOCOMPLETE.has(autocomplete)) return true;
    const desc = describeElement(el);
    if (isSensitiveName(desc.name) || isSensitiveName(desc.id) || isSensitiveName(desc.ariaLabel)) return true;
    if (isSensitiveName(labelFor(el))) return true;
    return false;
  }

  function describeActivation(el: Element | null, key?: string): {
    consequential: boolean;
    reason: string;
    tagName?: string;
    text?: string;
  } {
    if (!el) return { consequential: false, reason: "" };
    const interactive = (el.closest("button, input, a, form") ?? el) as HTMLElement;
    const tag = interactive.tagName.toLowerCase();
    const form =
      (interactive as HTMLButtonElement).form ??
      (interactive as HTMLInputElement).form ??
      interactive.closest("form");
    const buttonSubmit = interactive instanceof HTMLButtonElement && interactive.type === "submit" && Boolean(form);
    const inputSubmit =
      interactive instanceof HTMLInputElement &&
      (interactive.type === "submit" || interactive.type === "image") &&
      Boolean(form);
    const download = interactive instanceof HTMLAnchorElement && interactive.hasAttribute("download");
    const enterSubmits = key === "Enter" && Boolean(form);
    const consequential = buttonSubmit || inputSubmit || download || enterSubmits;
    const text =
      (interactive.textContent ?? "").replace(/\s+/g, " ").trim() ||
      (interactive as HTMLInputElement).value ||
      interactive.getAttribute("aria-label") ||
      "";
    return {
      consequential,
      reason: buttonSubmit || inputSubmit || enterSubmits ? "form-submit" : download ? "download" : "",
      tagName: tag,
      text: text.slice(0, 160),
    };
  }

  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const explicit = deepQuerySelectorAll(`label[for=${JSON.stringify(id)}]`)[0];
      if (explicit) return (explicit.textContent ?? "").trim();
    }
    const wrapping = el.closest("label");
    if (wrapping) return (wrapping.textContent ?? "").trim();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((token) => deepGetElementById(token)?.textContent ?? "")
        .join(" ")
        .trim();
      if (parts) return parts;
    }
    const placeholder = el.getAttribute("placeholder");
    return (placeholder ?? "").trim();
  }

  function implicitRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    switch (tag) {
      case "a":
        return el.hasAttribute("href") ? "link" : "";
      case "button":
        return "button";
      case "input":
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "search") return "searchbox";
        return "textbox";
      case "textarea":
        return "textbox";
      case "select":
        return "combobox";
      case "img":
        return "img";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "form":
        return "form";
      case "table":
        return "table";
      default:
        return "";
    }
  }

  function accName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((token) => deepGetElementById(token)?.textContent ?? "")
        .join(" ")
        .trim();
      if (parts) return parts;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const fromLabel = labelFor(el);
      if (fromLabel) return fromLabel;
    }
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function refFor(el: Element): string {
    const existing = elementRefs.get(el);
    if (existing && refElements.get(existing)?.deref() === el) return existing;
    const seq = Number(document.documentElement.dataset.muzeRefSeq ?? "0") + 1;
    document.documentElement.dataset.muzeRefSeq = String(seq);
    const ref = `r${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    elementRefs.set(el, ref);
    if (typeof WeakRef !== "undefined") refElements.set(ref, new WeakRef(el));
    el.setAttribute("data-muze-ref", ref);
    return ref;
  }

  // An element counts as live if it is in the document tree, including
  // inside a shadow root whose host is in the document. Plain
  // doc.contains() is false for shadow-tree elements (their parent chain
  // stops at the shadow root), so a contains-only check would wrongly
  // report every shadow-DOM ref as stale.
  function isInDocument(el: Element): boolean {
    if (doc.contains(el)) return true;
    const root = typeof el.getRootNode === "function" ? el.getRootNode() : null;
    const host = root && root !== doc ? (root as ShadowRoot).host : undefined;
    return host ? doc.contains(host) : false;
  }

  function resolve(ref: string): Element | null {
    if (!/^[A-Za-z0-9_-]+$/.test(ref)) return null;
    const safe = ref;
    const weak = refElements.get(safe);
    if (weak) {
      // A ref is bound to the exact element it was minted for. If that
      // element is gone (WeakRef dead, or detached from the document) the
      // ref is STALE — it must NOT be re-resolved by re-running the stored
      // find query, which could silently pick a different element that
      // happens to match now (a different form field, a different button).
      // Callers translate null into STALE_ELEMENT.
      const existing = weak.deref();
      if (existing && isInDocument(existing)) return existing;
      return null;
    }
    // No WeakRef entry (refs minted where WeakRef was unavailable): the
    // data-muze-ref attribute itself is the identity, so a scan for that
    // exact attribute is still the same element, not a re-query by content.
    const byAttribute = deepQuerySelectorAll(`[data-muze-ref="${safe}"]`)[0];
    if (byAttribute) {
      elementRefs.set(byAttribute, safe);
      if (typeof WeakRef !== "undefined") refElements.set(safe, new WeakRef(byAttribute));
      return byAttribute;
    }
    return null;
  }

  function queryAllElements(): Element[] {
    return deepQueryAll();
  }

  /** Shared select lookup for the select and selectIndex ops. An empty
   * value is treated as absent (it is what a label-only call degrades
   * to upstream), a non-empty value is tried first, and a label is
   * tried whenever the value is absent or matched nothing. Label
   * matching is by visible option text, never by value. */
  function findSelectOption(
    options: HTMLOptionElement[],
    value: string | undefined,
    label: string | undefined,
  ): HTMLOptionElement | undefined {
    const nonEmptyValue = value !== undefined && value !== "" ? value : undefined;
    if (nonEmptyValue !== undefined) {
      const byValue = options.find((o) => o.value === nonEmptyValue);
      if (byValue) return byValue;
    }
    if (label !== undefined && label !== "") {
      const wanted = label.trim();
      const byText = options.find((o) => o.text.trim() === wanted);
      if (byText) return byText;
      return options.find((o) => o.text.trim().toLowerCase() === wanted.toLowerCase());
    }
    return undefined;
  }

  /** Top-viewport box of one element, shared by the single- and
   * multi-ref ops. topViewportBox semantics: scroll into view first,
   * then measure; the frame walk is same-origin only (crossOrigin). */
  function topViewportBoxOf(el: HTMLElement, scrollFirst: boolean): { viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean } {
    if (scrollFirst) el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    let topX = rect.left;
    let topY = rect.top;
    let win: Window = window;
    while (win !== win.top) {
      let frameEl: HTMLElement | null;
      try {
        frameEl = win.frameElement as HTMLElement | null;
      } catch {
        break;
      }
      if (!frameEl) break;
      const fr = frameEl.getBoundingClientRect();
      topX += fr.left;
      topY += fr.top;
      win = win.parent;
    }
    return { viewportX: topX, viewportY: topY, width: rect.width, height: rect.height, crossOrigin: win !== win.top };
  }

  function matchBy(by: FindBy, value: string, role?: string, name?: string): Element[] {
    const lower = value.toLowerCase();
    switch (by) {
      case "selector":
        return deepQuerySelectorAll(value);
      case "text": {
        const matched = new Set<Element>();
        try {
          if (typeof doc.createTreeWalker === "function") {
            const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
            let n = walker.nextNode();
            while (n) {
              const txt = (n.textContent ?? "").toLowerCase();
              if (txt.includes(lower)) {
                const p = n.parentElement;
                if (p) matched.add(p);
              }
              n = walker.nextNode();
            }
          }
        } catch {
          // ignore walker failure
        }
        for (const el of deepQueryAll()) {
          const s = el.shadowRoot;
          if (s && typeof doc.createTreeWalker === "function") {
            try {
              const sw = doc.createTreeWalker(s, NodeFilter.SHOW_TEXT);
              let sn = sw.nextNode();
              while (sn) {
                const txt = (sn.textContent ?? "").toLowerCase();
                if (txt.includes(lower)) {
                  const p = sn.parentElement;
                  if (p) matched.add(p);
                }
                sn = sw.nextNode();
              }
            } catch {}
          }
        }
        if (matched.size > 0) {
          return Array.from(matched).filter((el) => !Array.from(el.children).some((child) => matched.has(child)));
        }
        return queryAllElements().filter((el) => {
          const text = (el.textContent ?? "").toLowerCase();
          if (!text.includes(lower)) return false;
          return !Array.from(el.children).some((child) => (child.textContent ?? "").toLowerCase().includes(lower));
        });
      }
      case "label":
        return queryAllElements().filter((el) => labelFor(el).toLowerCase().includes(lower));
      case "placeholder":
        return queryAllElements().filter((el) => (el.getAttribute("placeholder") ?? "").toLowerCase().includes(lower));
      case "role": {
        const roleLower = (role ?? value).toLowerCase();
        return queryAllElements().filter((el) => implicitRole(el).toLowerCase() === roleLower && (!name || accName(el).toLowerCase().includes(name.toLowerCase())));
      }
      case "name":
        return queryAllElements().filter((el) => accName(el).toLowerCase().includes(lower));
      default:
        return [];
    }
  }

  function snapshot(el: Element): ElementSnapshot {
    const tag = el.tagName.toLowerCase();
    return {
      ref: refFor(el),
      role: implicitRole(el) || undefined,
      name: accName(el) || undefined,
      tagName: tag,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || undefined,
    };
  }

  const POINTER_EVENT_TYPES: Record<string, string> = {
    mousedown: "pointerdown",
    mouseup: "pointerup",
    mousemove: "pointermove",
    mouseover: "pointerover",
    mouseout: "pointerout",
    mouseenter: "pointerenter",
    mouseleave: "pointerleave",
  };

  function pointerTypeFor(type: string): string | undefined {
    return POINTER_EVENT_TYPES[type];
  }

  function createPointerEvent(type: string, init: MouseEventInit): Event | null {
    if (typeof PointerEvent === "undefined") return null;
    return new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true } as PointerEventInit);
  }

  function dispatchSequence(el: Element, type: string, button: number): void {
    const rect = (el as HTMLElement).getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button,
    };
    const pointerType = pointerTypeFor(type);
    const pointerEvent = pointerType ? createPointerEvent(pointerType, init) : null;
    if (pointerEvent) el.dispatchEvent(pointerEvent);
    el.dispatchEvent(new MouseEvent(type, init));
  }

  function fireInput(el: Element): void {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchAt(el: Element, type: string, x: number, y: number, button: number): void {
    const init: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button };
    const pointerType = pointerTypeFor(type);
    const pointerEvent = pointerType ? createPointerEvent(pointerType, init) : null;
    if (pointerEvent) el.dispatchEvent(pointerEvent);
    el.dispatchEvent(new MouseEvent(type, init));
  }

  function targetAt(x: number, y: number): Element {
    return doc.elementFromPoint(x, y) ?? doc.body;
  }

  function dragSequence(fromEl: Element, x1: number, y1: number, toEl: Element, x2: number, y2: number): void {
    const dataTransfer = typeof DataTransfer !== "undefined" ? new DataTransfer() : null;
    fromEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    dispatchAt(fromEl, "mousedown", x1, y1, 0);
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      dispatchAt(targetAt(x, y), "mousemove", x, y, 0);
    }
    toEl.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
    toEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
    dispatchAt(toEl, "mouseup", x2, y2, 0);
    toEl.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    fromEl.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
  }

  switch (request.op) {
    case "readPage": {
      const body = doc.body;
      const text = ((body as any)?.innerText ?? body?.textContent ?? "").replace(/\n{3,}/g, "\n\n");
      const slice = text.slice(request.offset, request.offset + request.maxChars);
      return { text: slice, totalChars: text.length, offset: request.offset, truncated: request.offset + slice.length < text.length, nextOffset: request.offset + slice.length < text.length ? request.offset + slice.length : null };
    }
    case "metadata": {
      const headings = deepQueryAll().filter((h) => /^h[1-6]$/i.test(h.tagName)).map((h) => ({
        level: Number(h.tagName.substring(1)),
        text: (h.textContent ?? "").replace(/\s+/g, " ").trim(),
      }));
      // Meta tags whose content is a secret are dropped outright.
      const meta = deepQuerySelectorAll("meta[name],meta[property]")
        .map((m) => ({
          name: m.getAttribute("name") ?? m.getAttribute("property") ?? "",
          content: (m.getAttribute("content") ?? "").slice(0, 500),
        }))
        .filter((entry) => !SENSITIVE_META.test(entry.name));
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? undefined;
      const description = doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined;
      return {
        title: doc.title,
        url: location.href,
        canonicalUrl: canonical,
        description,
        language: doc.documentElement.lang || undefined,
        headings,
        meta,
      };
    }
    case "outline": {
      // Headings are either h1-h6 or any element with role="heading".
      const candidates = deepQueryAll().filter(
        (el) => /^h[1-6]$/i.test(el.tagName) || (el.getAttribute("role") ?? "").toLowerCase() === "heading",
      );
      const outline = candidates
        .map((h) => {
          const tagLevel = /^h[1-6]$/i.test(h.tagName) ? Number(h.tagName.substring(1)) : 0;
          const ariaLevel = Number(h.getAttribute("aria-level") ?? "");
          const level = tagLevel || (Number.isFinite(ariaLevel) && ariaLevel > 0 ? ariaLevel : 2);
          return { level, text: (h.textContent ?? "").replace(/\s+/g, " ").trim() };
        })
        .filter((h) => h.level <= request.maxDepth && h.text);
      return { outline };
    }
    case "links": {
      const origin = location.origin;
      const links: { text: string; href: string; rel?: string; target?: string; download?: string; internal: boolean }[] = [];
      for (const a of deepQuerySelectorAll("a[href]")) {
        const href = (a as HTMLAnchorElement).href;
        if (!href) continue;
        const scheme = href.split(":")[0]?.toLowerCase();
        if (scheme === "javascript" || scheme === "vbscript" || scheme === "data") continue;
        const internal = href.startsWith(origin);
        if (request.sameOriginOnly && !internal) continue;
        links.push({
          text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
          href: href.slice(0, 2048),
          rel: a.getAttribute("rel") ?? undefined,
          target: a.getAttribute("target") ?? undefined,
          download: a.getAttribute("download") ?? undefined,
          internal,
        });
        if (links.length >= request.limit) break;
      }
      return { links };
    }
    case "selected": {
      const sel = window.getSelection();
      return { text: sel ? sel.toString().slice(0, 20000) : "" };
    }
    case "readClipboard": {
      // Runs in the page's content context (not the offscreen document,
      // which is never focused, so navigator.clipboard.readText() there
      // always fails with "Document is not focused"). With the extension's
      // clipboardRead permission this succeeds whenever the tab's
      // document is focused; a rejection propagates to the caller, which
      // converts it to a clear focus-required error and reads nothing.
      // Returning the promise is intentional: executeScript / the test
      // context await the injected function's result.
      return (navigator.clipboard.readText() as Promise<string>).then((text) => ({
        text: text.slice(0, 100_000),
        truncated: text.length > 100_000,
      }));
    }
    case "writeClipboard": {
      // Page-context counterpart of readClipboard, for the clipboard
      // write self-focus fallback: the offscreen document is never
      // focused, so its writeText always fails, but a focused page
      // document can writeText with the extension's clipboardWrite
      // permission. A rejection propagates to the caller, which
      // converts a focus failure to the self-focus-attempted error.
      return (navigator.clipboard.writeText(request.text) as Promise<void>).then(() => ({
        written: true as const,
      }));
    }
    case "findText": {
      const body = ((doc.body as any)?.innerText ?? doc.body?.textContent ?? "") as string;
      const haystack = request.caseSensitive ? body : body.toLowerCase();
      const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
      // Shape must match page.find's declared output exactly
      // ({matches:[{index, text, context?}], total}): the old shape
      // ({matches:[{excerpt, index}], totalMatches}) failed the executor's
      // output validation on the query path ("Tool page.find produced
      // output that failed its schema"). text is the matched substring in
      // its original case; context is the surrounding excerpt.
      const matches: { index: number; text: string; context: string }[] = [];
      let from = 0;
      let total = 0;
      while (true) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        total += 1;
        if (matches.length < request.limit) {
          const start = Math.max(0, idx - request.contextChars);
          const end = Math.min(body.length, idx + needle.length + request.contextChars);
          matches.push({
            index: idx,
            text: body.slice(idx, idx + needle.length),
            context: body.slice(start, end).replace(/\s+/g, " ").trim(),
          });
        }
        from = idx + needle.length;
      }
      return { matches, total };
    }
    case "tables": {
      const tableEls = deepQuerySelectorAll("table");
      const tables = tableEls
        .filter((_, i) => request.index === undefined || i === request.index)
        .map((table, i) => {
          const rows = deepQueryAll(table).filter((el) => el.tagName === "TR");
          const cells = (row: Element): Element[] => deepQueryAll(row).filter((el) => el.tagName === "TD" || el.tagName === "TH");
          const headers = (rows[0] ? cells(rows[0]) : []).map((c) => (c.textContent ?? "").trim());
          const bodyRows = rows.slice(1, request.maxRows + 1).map((row) =>
            cells(row).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500)),
          );
          return { index: request.index ?? i, headers, rows: bodyRows, truncated: rows.length - 1 > request.maxRows };
        });
      return { tables };
    }
    case "findElements": {
      const els = matchBy(request.by, request.value, request.role, request.name).slice(0, request.limit);
      // Refs are minted here and bound to these exact elements; the find
      // query is deliberately NOT stored, so a later resolve() can never
      // re-run it and land on a different element.
      const elements = els.map((el) => snapshot(el));
      return { elements };
    }
    case "readElement": {
      const el = resolve(request.ref);
      if (!el) return { error: "STALE_ELEMENT" };
      const attributes: Record<string, string> = {};
      for (const name of request.attributes) {
        // Attributes that carry a live value are never collected; the handler
        // drops them again as a second line of defence.
        if (BLOCKED_ATTRIBUTES.has(name.toLowerCase())) continue;
        const value = el.getAttribute(name);
        if (value !== null) attributes[name] = value.slice(0, 1000);
      }
      return {
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 5000),
        attributes,
        element: describeElement(el),
      };
    }
    case "activationCheck": {
      const el =
        request.ref !== undefined
          ? (resolve(request.ref) as Element | null)
          : request.x !== undefined && request.y !== undefined
            ? targetAt(request.x, request.y)
            : null;
      return describeActivation(el, request.key);
    }
    case "click": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      const button = request.button === "right" ? 2 : request.button === "middle" ? 1 : 0;
      el.scrollIntoView({ block: "center" });
      dispatchSequence(el, "mousedown", button);
      dispatchSequence(el, "mouseup", button);
      if (button === 0) {
        // Exactly one click event: the synthetic dispatch above. Calling
        // el.click() as well used to fire a second activation, so a page
        // counting clicks (or submitting on click) acted twice.
        dispatchSequence(el, "click", button);
      }
      return { clicked: true, ref: request.ref, url: location.href };
    }
    case "focus": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      el.focus();
      return { focused: true, ref: request.ref };
    }
    case "focusAt": {
      // Coordinate-path focus: the element at the point, focused
      // directly. A synthetic mousedown does not move focus, so the
      // coordinate typing path needs this instead of relying on the
      // click to focus. Returns the tag so the caller can report it.
      const target = targetAt(request.x, request.y) as HTMLElement | null;
      if (!target || typeof target.focus !== "function") return { focused: false, tagName: target?.tagName.toLowerCase() ?? "" };
      target.focus();
      return { focused: true, tagName: target.tagName.toLowerCase() };
    }
    case "focusedValue": {
      // Read-back for the coordinate typing path: what the browser
      // actually has focused (not what a ref resolved to), whether it
      // is visible, and what text it holds. Used only for the landed
      // check inside the handler; the handler never returns the value.
      const active = doc.activeElement as HTMLElement | null;
      if (!active) return { tagName: "", visible: false };
      const isField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      return {
        tagName: active.tagName.toLowerCase(),
        visible: isVisible(active),
        ...(isField ? { value: (active as HTMLInputElement | HTMLTextAreaElement).value } : {}),
        ...(active.isContentEditable ? { textContent: active.textContent ?? "" } : {}),
      };
    }
    case "hover": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      dispatchSequence(el, "mouseover", 0);
      dispatchSequence(el, "mousemove", 0);
      return { hovered: true, ref: request.ref };
    }
    case "scrollPage": {
      const amount = request.direction === "top" ? -window.scrollY : request.direction === "bottom" ? doc.body.scrollHeight : request.direction === "up" ? -request.amount : request.amount;
      window.scrollBy({ top: amount, behavior: "auto" });
      return { scrollY: window.scrollY, scrollHeight: doc.body.scrollHeight };
    }
    case "scrollTo": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      el.scrollIntoView({ block: "center", inline: "center" });
      return { scrolled: true, ref: request.ref };
    }
    case "scrollToXY": {
      // Absolute page scroll used by act scroll steps carrying x/y. This is
      // a coordinate scroll, distinct from dom.scroll (direction/amount)
      // and from dom.scrollTo (an element ref into view).
      window.scrollTo({ left: request.x, top: request.y, behavior: "instant" as ScrollBehavior });
      return { scrollX: window.scrollX, scrollY: window.scrollY, scrollHeight: doc.body.scrollHeight };
    }
    case "elementDescriptor": {
      // Internal use only (dom.fill / dom.type guards): the element's
      // identifying attributes plus its visible label, so the handler can
      // apply the same sensitive-field rule as forms.fill.
      const el = resolve(request.ref);
      if (!el) return { error: "STALE_ELEMENT" };
      return { element: describeElement(el), label: labelFor(el) };
    }
    case "select": {
      const el = resolve(request.ref) as HTMLSelectElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      // A non-select element has no .options: Array.from(undefined) used
      // to throw "undefined is not iterable" here, which surfaced as a
      // confusing ok:false. Fail with a typed error instead.
      if (el.tagName !== "SELECT" || !("options" in el)) return { error: "INVALID_INPUT" };
      const options = Array.from(el.options);
      // Lookup order, fixed for the retest3 label failure: a caller that
      // normalises a missing value to "" (gateway act adaptation sends
      // value:"" for a label-only select) must NOT let that empty value
      // shadow the label, and a value that matches nothing must fall
      // back to the label instead of reporting not-selected. Visible
      // text is matched trimmed, with a case-insensitive fallback, so
      // "Three" finds an option whose text is "Three" even when its
      // value is "3" — value-only matching could never do that.
      const chosen = findSelectOption(options, request.value, request.label);
      if (!chosen) return { selected: false, value: el.value };
      el.value = chosen.value;
      fireInput(el);
      return { selected: true, value: el.value };
    }
    case "topViewportBox":
    case "topBox": {
      // Top-viewport coordinates of an element, for CDP input, which is
      // addressed in top-viewport pixels even when the element lives in
      // a sub-frame. topViewportBox scrolls into view first (like
      // boundingBox); topBox does not, so a wheel-scroll loop can measure
      // without moving the element itself. The walk up frameElement
      // works only for same-origin frames: for a cross-origin frame,
      // frameElement is null, the walk stops early, and crossOrigin is
      // true, so the caller must fall back to synthetic input rather
      // than click at the wrong top-viewport point.
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      return topViewportBoxOf(el, request.op === "topViewportBox");
    }
    case "topViewportBoxes": {
      // Atomic dual measurement for dom.drag: the old handler measured
      // from and to in two separate page ops, so the page could scroll
      // (each topViewportBox scrolls its element into view) or re-render
      // between the two measurements — the from coordinates were then
      // measured in a different scroll state than the to coordinates,
      // and a ref replaced between the two calls failed as a bare
      // STALE_ELEMENT naming neither ref. Here both refs resolve in one
      // injection: the from element is scrolled into view once, then
      // both boxes are measured in that same scroll state. A stale ref
      // is reported per position (staleIndex + staleRef), never silently
      // re-resolved to a different element; the caller re-observes.
      const boxes: ({ viewportX: number; viewportY: number; width: number; height: number; crossOrigin: boolean; stale: false } | { stale: true })[] = [];
      for (let i = 0; i < request.refs.length; i++) {
        const el = resolve(request.refs[i]) as HTMLElement | null;
        if (!el) {
          boxes.push({ stale: true });
          continue;
        }
        // Scroll only the first element into view, once, before any
        // measurement, so both boxes share one scroll state.
        boxes.push({ ...topViewportBoxOf(el, i === 0), stale: false });
      }
      // Deliberately NOT returned as {error: "STALE_ELEMENT"}: runPageOp
      // turns an error field into a bare STALE_ELEMENT that names neither
      // ref. The per-box stale flags let the dom.drag handler throw a
      // precise error naming exactly which ref went stale.
      return { boxes };
    }
    case "selectIndex": {
      const el = resolve(request.ref) as HTMLSelectElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el.tagName !== "SELECT" || !("options" in el)) {
        return { selectedIndex: -1, optionIndex: -1, value: "", multiple: false, notSelect: true, tagName: el.tagName };
      }
      const options = Array.from(el.options);
      // Same lookup as the select op (see findSelectOption): an empty
      // value must not shadow a label, and a value miss must fall back
      // to the label. A -1 here used to make dom.select return
      // selected:false without ever trying the DOM path.
      const found = findSelectOption(options, request.value, request.label);
      const optionIndex = found ? options.indexOf(found) : -1;
      return { selectedIndex: el.selectedIndex, optionIndex, value: el.value, multiple: el.multiple };
    }
    case "checkedState": {
      const el = resolve(request.ref) as HTMLInputElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      return { checked: el.checked };
    }
    case "scrollState": {
      return { scrollY: window.scrollY, scrollHeight: doc.body.scrollHeight };
    }
    case "setChecked": {
      const el = resolve(request.ref) as HTMLInputElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el.checked !== request.checked) el.click();
      return { checked: el.checked };
    }
    case "setRadio": {
      const el = resolve(request.ref) as HTMLInputElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      el.click();
      return { checked: el.checked };
    }
    case "setValue": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, request.value);
        else el.value = request.value;
      } else if (el.isContentEditable) {
        el.textContent = request.value;
      } else {
        return { error: "UNSUPPORTED" };
      }
      fireInput(el);
      return { filled: true, ref: request.ref };
    }
    case "clear": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        // Use the native setter so React's controlled inputs notice the change.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, "");
        else el.value = "";
      } else if (el.isContentEditable) {
        el.textContent = "";
      } else {
        return { error: "UNSUPPORTED" };
      }
      fireInput(el);
      return { cleared: true, ref: request.ref };
    }
    case "submit": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      const form = el instanceof HTMLFormElement ? el : el.closest("form");
      if (form instanceof HTMLFormElement) {
        form.requestSubmit();
      } else if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && el.type === "submit")) {
        el.click();
      } else {
        return { error: "UNSUPPORTED" };
      }
      // dispatched means only that the submit was issued. verified stays
      // false: this call does not observe a navigation or a result, so it
      // must never be reported as a verified submission.
      return { submitted: true, dispatched: true, verified: false, ref: request.ref };
    }
    case "waitForElement": {
      const start = Date.now();
      return new Promise((resolvePromise) => {
        const check = () => {
          const match = matchBy(request.by, request.value, request.role, request.name).find((el) => (request.visible ? isVisible(el) : true));
          if (match) {
            resolvePromise({ found: true, ref: refFor(match), timedOut: false });
            return true;
          }
          if (Date.now() - start >= request.timeoutMs) {
            resolvePromise({ found: false, ref: null, timedOut: true });
            return true;
          }
          return false;
        };
        if (check()) return;
        const observer = new MutationObserver(() => {
          observeDeep(observer);
          if (check()) observer.disconnect();
        });
        observeDeep(observer);
        setTimeout(() => {
          if (check()) observer.disconnect();
        }, request.timeoutMs);
      });
    }
    case "inspectForms": {
      const formEls = deepQueryAll().filter((el) => el.tagName === "FORM") as HTMLFormElement[];
      const forms: FormSnapshot[] = formEls.map((form) => ({
        ref: refFor(form),
        action: form.getAttribute("action") ?? undefined,
        method: (form.getAttribute("method") ?? undefined)?.toUpperCase(),
        fields: deepQueryAll(form)
          .filter((field) => /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName))
          .map((field) => {
            const type = (field.getAttribute("type") ?? field.tagName.toLowerCase()).toLowerCase();
            const select = field instanceof HTMLSelectElement ? field : null;
            return {
              ref: refFor(field),
              label: labelFor(field) || (field.getAttribute("name") ?? ""),
              type,
              required: field.hasAttribute("required") || field.getAttribute("aria-required") === "true",
              options: select ? Array.from(select.options).map((o) => o.text.trim()).slice(0, 50) : undefined,
            };
          }),
      }));
      return { forms };
    }
    case "fillForm": {
      const filled: { ref: string; field: string; value: string }[] = [];
      const skipped: { field: string; reason: string }[] = [];
      for (const item of request.fields) {
        const el = resolve(item.ref) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) {
          skipped.push({ field: item.ref, reason: "stale or missing element" });
          continue;
        }
        // Same detection as dom.fill's handler-level guard (type, name, id,
        // aria-label, visible label, autocomplete) — not a narrow regex.
        if (isSensitiveField(el)) {
          skipped.push({ field: labelFor(el) || item.ref, reason: "sensitive field is never filled" });
          continue;
        }
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          skipped.push({ field: labelFor(el) || item.ref, reason: "use dom.setChecked/setRadio for toggles" });
          continue;
        }
        if (el instanceof HTMLSelectElement) {
          el.value = item.value;
        } else {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, item.value);
          else el.value = item.value;
        }
        fireInput(el);
        filled.push({ ref: item.ref, field: labelFor(el) || item.ref, value: "•".repeat(Math.min(item.value.length, 8)) });
      }
      return { filled, skipped };
    }
    case "getViewport":
      return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio, scrollY: window.scrollY };
    case "elementRect": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        viewportX: rect.left,
        viewportY: rect.top,
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio,
      };
    }
    case "domStructure": {
      const nodes: { depth: number; tag: string; id?: string; classes: string[] }[] = [];
      const walk = (el: Element, depth: number) => {
        if (nodes.length >= request.maxNodes || depth > request.maxDepth) return;
        nodes.push({ depth, tag: el.tagName.toLowerCase(), id: el.id || undefined, classes: Array.from(el.classList).slice(0, 5) });
        for (const child of Array.from(el.children)) walk(child, depth + 1);
        const shadow = (el as Element).shadowRoot;
        if (shadow) for (const child of Array.from(shadow.children)) walk(child, depth + 1);
      };
      if (doc.body) walk(doc.body, 0);
      return { nodes };
    }
    case "performance": {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const paints = performance.getEntriesByType("paint") as PerformanceEntry[];
      const navigation: Record<string, number> = {};
      if (nav) {
        navigation.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
        navigation.load = Math.round(nav.loadEventEnd);
        navigation.responseTime = Math.round(nav.responseEnd);
        navigation.transferSize = nav.transferSize ?? 0;
      }
      const paint: Record<string, number> = {};
      for (const entry of paints) paint[entry.name] = Math.round(entry.startTime);
      return { navigation, paint, resources: performance.getEntriesByType("resource").length };
    }
    case "type": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!isField && !el.isContentEditable) return { error: "UNSUPPORTED" };
      el.focus();
      for (const ch of request.text) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true }));
        if (isField) {
          const field = el as HTMLInputElement | HTMLTextAreaElement;
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? field.value.length;
          const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const next = field.value.slice(0, start) + ch + field.value.slice(end);
          if (setter) setter.call(field, next);
          else field.value = next;
          try {
            field.setSelectionRange(start + ch.length, start + ch.length);
          } catch {
            /* input types such as email or number reject selection APIs */
          }
          fireInput(field);
        } else {
          const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, ch);
          if (!inserted) {
            el.textContent = (el.textContent ?? "") + ch;
            fireInput(el);
          }
        }
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
      return { typed: true, ref: request.ref };
    }
    case "press": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      const mods = request.modifiers;
      const init: KeyboardEventInit = {
        key: request.key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: mods.includes("Control"),
        shiftKey: mods.includes("Shift"),
        altKey: mods.includes("Alt"),
        metaKey: mods.includes("Meta"),
      };
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { pressed: true, ref: request.ref };
    }
    case "typeFocused": {
      // Coordinate-path typing: type into the element the browser
      // actually has focused, WITHOUT resolving or focusing any ref —
      // that refocus is exactly what sent CDP input to a hidden
      // element. Per-character, mirroring the "type" case.
      const el = doc.activeElement as HTMLElement | null;
      if (!el) return { error: "UNSUPPORTED" };
      const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!isField && !el.isContentEditable) return { error: "UNSUPPORTED" };
      for (const ch of request.text) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true }));
        if (isField) {
          const field = el as HTMLInputElement | HTMLTextAreaElement;
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? field.value.length;
          const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          const next = field.value.slice(0, start) + ch + field.value.slice(end);
          if (setter) setter.call(field, next);
          else field.value = next;
          try {
            field.setSelectionRange(start + ch.length, start + ch.length);
          } catch {
            /* input types such as email or number reject selection APIs */
          }
          fireInput(field);
        } else {
          const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, ch);
          if (!inserted) {
            el.textContent = (el.textContent ?? "") + ch;
            fireInput(el);
          }
        }
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
      return { typed: true };
    }
    case "pressFocused": {
      // Coordinate-path press: key events on the actually focused
      // element, without resolving or focusing any ref.
      const el = doc.activeElement as HTMLElement | null;
      if (!el) return { error: "UNSUPPORTED" };
      const mods = request.modifiers;
      const init: KeyboardEventInit = {
        key: request.key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ctrlKey: mods.includes("Control"),
        shiftKey: mods.includes("Shift"),
        altKey: mods.includes("Alt"),
        metaKey: mods.includes("Meta"),
      };
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return { pressed: true };
    }
    case "clickAt": {
      const target = (targetAt(request.x, request.y) as HTMLElement | null) ?? (doc.documentElement as HTMLElement);
      dispatchAt(target, "mousedown", request.x, request.y, 0);
      dispatchAt(target, "mouseup", request.x, request.y, 0);
      dispatchAt(target, "click", request.x, request.y, 0);
      return { clicked: true, x: request.x, y: request.y, tagName: target.tagName.toLowerCase() };
    }
    case "moveTo": {
      dispatchAt(targetAt(request.x, request.y), "mousemove", request.x, request.y, 0);
      return { moved: true, x: request.x, y: request.y };
    }
    case "drag": {
      const fromEl = resolve(request.fromRef) as HTMLElement | null;
      const toEl = resolve(request.toRef) as HTMLElement | null;
      if (!fromEl || !toEl) return { error: "STALE_ELEMENT" };
      fromEl.scrollIntoView({ block: "center", inline: "center" });
      const a = fromEl.getBoundingClientRect();
      const b = toEl.getBoundingClientRect();
      dragSequence(fromEl, a.left + a.width / 2, a.top + a.height / 2, toEl, b.left + b.width / 2, b.top + b.height / 2);
      return { dragged: true, fromRef: request.fromRef, toRef: request.toRef };
    }
    case "dragAt": {
      dragSequence(targetAt(request.x1, request.y1), request.x1, request.y1, targetAt(request.x2, request.y2), request.x2, request.y2);
      return { dragged: true, x1: request.x1, y1: request.y1, x2: request.x2, y2: request.y2 };
    }
    case "boundingBox": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        viewportX: rect.left,
        viewportY: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }
    case "visible": {
      const el = resolve(request.ref) as HTMLElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (!isVisible(el)) return { visible: false };
      // A visible element can still be covered by another one.
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
        const top = doc.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          return { visible: true, occluded: true };
        }
      }
      return { visible: true, occluded: false };
    }
    case "extractFields": {
      const results: Record<string, string> = {};
      const elements: Record<string, { tagName?: string; type?: string; name?: string; id?: string; autocomplete?: string; ariaLabel?: string; metaName?: string }> = {};
      for (const field of request.fields) {
        let el: Element | null = null;
        try {
          el = deepQuerySelectorAll(field.selector)[0] ?? null;
        } catch {
          el = null;
        }
        if (!el) {
          results[field.name] = "";
          continue;
        }
        elements[field.name] = describeElement(el);
        if (isSensitiveField(el)) {
          // Never read a credential out of the page, by type, name, id,
          // label or autocomplete — not just password/hidden types. The
          // handler applies the same rule on top of this.
          results[field.name] = "[redacted]";
          continue;
        }
        if (field.attribute) {
          if (BLOCKED_ATTRIBUTES.has(field.attribute.toLowerCase())) {
            results[field.name] = "[redacted]";
          } else {
            results[field.name] = (el.getAttribute(field.attribute) ?? "").slice(0, 2000);
          }
        } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          results[field.name] = el.value.slice(0, 2000);
        } else {
          results[field.name] = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
        }
      }
      return { results, elements };
    }
    case "waitForSelector": {
      const start = Date.now();
      return new Promise((resolvePromise) => {
        const check = () => {
          let match: Element | null = null;
          try {
            match = deepQuerySelectorAll(request.selector)[0] ?? null;
          } catch {
            match = null;
          }
          if (match) {
            resolvePromise({ found: true, ref: refFor(match), timedOut: false });
            return true;
          }
          if (Date.now() - start >= request.timeoutMs) {
            resolvePromise({ found: false, ref: null, timedOut: true });
            return true;
          }
          return false;
        };
        if (check()) return;
        const observer = new MutationObserver(() => {
          observeDeep(observer);
          if (check()) observer.disconnect();
        });
        observeDeep(observer);
        setTimeout(() => {
          if (check()) observer.disconnect();
        }, request.timeoutMs);
      });
    }
    case "previewForm": {
      const el = resolve(request.ref);
      if (!el) return { error: "STALE_ELEMENT" };
      const form = el instanceof HTMLFormElement ? el : el.closest("form");
      if (!(form instanceof HTMLFormElement)) return { error: "UNSUPPORTED" };
      const fields = deepQueryAll(form)
        .filter((field) => /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName))
        .map((field) => {
          const type = (field.getAttribute("type") ?? field.tagName.toLowerCase()).toLowerCase();
          const select = field instanceof HTMLSelectElement ? field : null;
          return {
            ref: refFor(field),
            label: labelFor(field) || (field.getAttribute("name") ?? ""),
            type,
            required: field.hasAttribute("required") || field.getAttribute("aria-required") === "true",
            options: select ? Array.from(select.options).map((o) => o.text.trim()).slice(0, 50) : undefined,
          };
        });
      return { fields };
    }
    case "shadowRoots": {
      // Enumerate the open shadow roots, which is where most web-component
      // based applications keep their real UI.
      const hosts: { tagName: string; id?: string; className?: string; childCount: number; depth: number }[] = [];
      const walk = (node: ParentNode, depth: number): void => {
        if (depth > request.maxDepth) return;
        for (const el of Array.from(node.children)) {
          const shadow = (el as Element).shadowRoot;
          if (!shadow) {
            walk(el, depth);
            continue;
          }
          hosts.push({
            tagName: el.tagName.toLowerCase(),
            id: el.getAttribute("id") ?? undefined,
            className: el.getAttribute("class") ?? undefined,
            childCount: shadow.querySelectorAll("*").length,
            depth,
          });
          walk(shadow, depth + 1);
        }
      };
      walk(doc, 0);
      return { hosts };
    }
    case "snapshot":
    case "a11yTree": {
      // A best-effort accessibility tree built from the DOM. Chrome's real AX
      // tree is only reachable through the debugger, which Muze never attaches.
      const nodes: {
        ref: string;
        role: string;
        name: string;
        value?: string;
        description?: string;
        checked?: boolean;
        disabled?: boolean;
        focused?: boolean;
        level?: number;
        children: number;
      }[] = [];
      const visit = (el: Element, depth: number): void => {
        if (nodes.length >= request.maxNodes || depth > request.maxDepth) return;
        const role = implicitRole(el);
        const interactive = /button|link|textbox|checkbox|radio|combobox|listbox|option|menuitem|tab|switch|slider|searchbox/.test(role);
        if (!request.interactiveOnly || interactive) {
          const rect = (el as HTMLElement).getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
          const entry: {
            ref: string;
            role: string;
            name: string;
            value?: string;
            description?: string;
            checked?: boolean;
            disabled?: boolean;
            focused?: boolean;
            level?: number;
            children: number;
            viewportX?: number;
            viewportY?: number;
            width?: number;
            height?: number;
          } = {
            ref: refFor(el),
            role,
            name: accName(el).slice(0, 300),
            children: el.children.length,
            viewportX: rect.left,
            viewportY: rect.top,
            width: rect.width,
            height: rect.height,
          };
          const desc = el.getAttribute("aria-description") ?? el.getAttribute("title");
          if (desc) entry.description = desc.slice(0, 300);
          // Credential field values never appear in snapshot/a11y output.
          // This is field-aware (type, name, id, label, autocomplete), not
          // just password/hidden, so e.g. a text input named "cardNumber"
          // does not leak its value either.
          const sensitive = isSensitiveField(el);
          if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox" || el.type === "radio") entry.checked = el.checked;
            if (!sensitive) entry.value = el.value.slice(0, 200);
          }
          if (el instanceof HTMLTextAreaElement && !sensitive) entry.value = el.value.slice(0, 200);
          if (el instanceof HTMLSelectElement && !sensitive) entry.value = el.selectedOptions[0]?.text?.trim().slice(0, 200);
          if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
          if (doc.activeElement === el) entry.focused = true;
          const ariaLevel = Number(el.getAttribute("aria-level") ?? "");
          if (Number.isFinite(ariaLevel) && ariaLevel > 0) entry.level = ariaLevel;
          nodes.push(entry);
        }
        for (const child of Array.from(el.children)) visit(child, depth + 1);
        const shadow = (el as Element).shadowRoot;
        if (shadow) for (const child of Array.from(shadow.children)) visit(child, depth + 1);
      };
      if (doc.body) visit(doc.body, 0);
      if (request.op === "snapshot") {
        return {
          nodes,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            scrollY: window.scrollY,
          },
        };
      }
      return { nodes };
    }
    case "setFile": {
      const el = (deepQuerySelectorAll(request.selector)[0] ?? null) as HTMLInputElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el.tagName !== "INPUT" || el.type !== "file") return { error: "UNSUPPORTED" };
      const transfer = new DataTransfer();
      for (const file of request.files) {
        const binary = atob(file.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], file.name, { type: file.mimeType || "application/octet-stream" }));
      }
      el.files = transfer.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { set: true, files: Array.from(el.files).map((f) => ({ name: f.name, mimeType: f.type || "application/octet-stream", size: f.size })) };
    }
    case "setFileByRef": {
      // The ref path exists because a ref is an opaque registry id
      // (e.g. "r3xab"), NOT a CSS selector: passing it to
      // querySelectorAll silently matches nothing and reports
      // STALE_ELEMENT even for a live element — exactly the unified
      // submit set_file failure. resolve() is an exact registry lookup
      // for the element the ref was minted for: a dead/detached ref
      // still returns null and still reports STALE_ELEMENT, so a stale
      // ref is never silently re-resolved to a different element.
      const el = resolve(request.ref) as HTMLInputElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el.tagName !== "INPUT" || el.type !== "file") return { error: "UNSUPPORTED" };
      const transfer = new DataTransfer();
      for (const file of request.files) {
        const binary = atob(file.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], file.name, { type: file.mimeType || "application/octet-stream" }));
      }
      el.files = transfer.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { set: true, files: Array.from(el.files).map((f) => ({ name: f.name, mimeType: f.type || "application/octet-stream", size: f.size })) };
    }
    case "uploadFiles": {
      const el = resolve(request.ref) as HTMLInputElement | null;
      if (!el) return { error: "STALE_ELEMENT" };
      if (el.tagName !== "INPUT" || el.type !== "file") return { error: "UNSUPPORTED" };
      const transfer = new DataTransfer();
      for (const file of request.files) {
        const binary = atob(file.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], file.name, { type: file.mimeType || "application/octet-stream" }));
      }
      el.files = transfer.files;
      fireInput(el);
      return { uploaded: el.files.length, names: Array.from(el.files).map((f) => f.name) };
    }
    case "networkIdle": {
      // The page's resource timeline is the best signal available from inside
      // the page: a page that keeps loading shows a growing resource count.
      const start = Date.now();
      let lastCount = -1;
      let lastChange = Date.now();
      return new Promise((resolvePromise) => {
        const check = (): boolean => {
          const count = performance.getEntriesByType("resource").length;
          if (count !== lastCount) {
            lastCount = count;
            lastChange = Date.now();
          }
          const ready = doc.readyState === "complete";
          const quiet = Date.now() - lastChange >= request.quietMs;
          if (ready && quiet) {
            resolvePromise({ idle: true, pending: 0, waitedMs: Date.now() - start, timedOut: false });
            return true;
          }
          if (Date.now() - start >= request.timeoutMs) {
            resolvePromise({ idle: false, pending: count, waitedMs: Date.now() - start, timedOut: true });
            return true;
          }
          return false;
        };
        if (check()) return;
        const timer = setInterval(() => {
          if (check()) clearInterval(timer);
        }, 100);
      });
    }
    case "pageMetrics": {
      return {
        scrollHeight: Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio,
        scrollY: window.scrollY,
      };
    }
    case "scrollToY": {
      window.scrollTo({ top: request.y, behavior: "instant" as ScrollBehavior });
      return { scrollY: window.scrollY };
    }
    case "hideSticky": {
      // Sticky headers and footers would repeat in every stitched slice, so
      // they are neutralised for the duration of the capture.
      const style = doc.getElementById("muze-sticky-style") as HTMLStyleElement | null;
      if (request.hidden) {
        if (!style) {
          const created = doc.createElement("style");
          created.id = "muze-sticky-style";
          created.textContent =
            "*{scroll-behavior:auto !important} [style*='position:sticky'],[style*='position: fixed'],[style*='position:fixed'],[style*='position:sticky']{position:static !important;visibility:hidden !important}";
          doc.documentElement.appendChild(created);
        }
      } else if (style) {
        style.remove();
      }
      return { hidden: request.hidden };
    }
    default:
      return { error: "UNSUPPORTED" };
  }
}
