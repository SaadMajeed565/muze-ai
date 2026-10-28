/**
 * Optional diagnostics hook. Self-contained so it can be injected with
 * chrome.scripting.executeScript. It only records messages observed after it is
 * installed; it cannot recover historical console output.
 */

export interface DiagnosticsLog {
  console: { level: string; text: string; at: string }[];
  errors: { message: string; source?: string; at: string }[];
}

// NOTE (retest3 devtools null-read fix): these functions are injected with
// chrome.scripting.executeScript in the MAIN world, which serialises the
// function source and does NOT carry module scope with it. The storage key
// therefore used to be a module-level constant (GLOBAL_KEY) that the
// serialised function could not resolve in the page, so the read-back could
// come back null instead of the log installed by the hook. The key is now a
// literal inside each function, so each injected function is genuinely
// self-contained; the hook and the reader must use the same literal.
export function diagnosticsHook(): void {
  const w = window as unknown as Record<string, unknown>;
  const existing = (w["__muzeDiagnostics"] as DiagnosticsLog | undefined) ?? { console: [], errors: [] };
  if ((existing as { __installed?: boolean }).__installed) return;
  (existing as { __installed?: boolean }).__installed = true;

  const bound = 200;
  const push = (entry: { level: string; text: string; at: string }) => {
    existing.console.push(entry);
    if (existing.console.length > bound) existing.console.shift();
  };

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);

  console.error = (...args: unknown[]) => {
    push({ level: "error", text: args.map(String).join(" ").slice(0, 2000), at: new Date().toISOString() });
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    push({ level: "warn", text: args.map(String).join(" ").slice(0, 2000), at: new Date().toISOString() });
    originalWarn(...args);
  };
  console.log = (...args: unknown[]) => {
    push({ level: "log", text: args.map(String).join(" ").slice(0, 2000), at: new Date().toISOString() });
    originalLog(...args);
  };
  console.info = (...args: unknown[]) => {
    push({ level: "info", text: args.map(String).join(" ").slice(0, 2000), at: new Date().toISOString() });
    originalInfo(...args);
  };

  window.addEventListener("error", (event) => {
    existing.errors.push({
      message: String(event.message).slice(0, 2000),
      source: event.filename ? `${event.filename}:${event.lineno ?? 0}` : undefined,
      at: new Date().toISOString(),
    });
    if (existing.errors.length > bound) existing.errors.shift();
  });
  window.addEventListener("unhandledrejection", (event) => {
    existing.errors.push({ message: `Unhandled rejection: ${String(event.reason)}`.slice(0, 2000), at: new Date().toISOString() });
    if (existing.errors.length > bound) existing.errors.shift();
  });

  w["__muzeDiagnostics"] = existing;
}

export function readDiagnosticsLog(): DiagnosticsLog {
  const w = window as unknown as Record<string, DiagnosticsLog | undefined>;
  return w["__muzeDiagnostics"] ?? { console: [], errors: [] };
}
