import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Button } from "./primitives.js";
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "./confirm.js";
import { Sheet } from "./shared.js";

export type ToastTone = "success" | "danger" | "info";

interface ToastDetail {
  message: string;
  tone: ToastTone;
}

interface ToastItem extends ToastDetail {
  id: number;
}

/** Show a short, non-blocking confirmation for a successful action. */
export function showToast(message: string, tone: ToastTone = "success"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastDetail>("muze:toast", { detail: { message, tone } }));
}

export function Toaster(): preact.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (!detail?.message) return;
      const id = nextId.current++;
      setItems((current) => [...current.slice(-2), { id, ...detail }]);
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 3200);
    };
    window.addEventListener("muze:toast", listener);
    return () => window.removeEventListener("muze:toast", listener);
  }, []);

  return (
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div class={`toast toast--${item.tone}`} role="status" key={item.id}>
          <span class={`toast-dot toast-dot--${item.tone}`} aria-hidden="true" />
          <span>{item.message}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Promise-based confirmation sheet. Replaces every native confirm() with
 * a focus-trapped, mobile-friendly dialog. `requireText` gates destructive
 * actions behind an explicit typed word.
 */
export function ConfirmProvider({ children }: { children?: preact.ComponentChildren }): preact.JSX.Element {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setTyped("");
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = useCallback((value: boolean) => {
    const settle = resolver.current;
    resolver.current = null;
    setOptions(null);
    setTyped("");
    settle?.(value);
  }, []);

  const matches = !options?.requireText || typed.trim() === options.requireText;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Sheet open={options !== null} label={options?.title ?? "Confirm"} onClose={() => finish(false)}>
        {options ? (
          <div class="confirm-sheet">
            <p class="confirm-body">{options.body}</p>
            {options.requireText ? (
              <label class="field-label" for="confirm-text">
                Type “{options.requireText}” to continue
                <input
                  id="confirm-text"
                  class="text-input"
                  value={typed}
                  autoComplete="off"
                  onInput={(event) => setTyped((event.target as HTMLInputElement).value)}
                />
              </label>
            ) : null}
            <div class="sheet-actions">
              <Button variant="ghost" onClick={() => finish(false)}>
                {options.cancelLabel ?? "Keep it"}
              </Button>
              <Button
                variant={options.tone === "danger" ? "danger" : "primary"}
                disabled={!matches}
                onClick={() => finish(true)}
              >
                {options.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </ConfirmContext.Provider>
  );
}
