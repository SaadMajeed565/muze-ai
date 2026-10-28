import type { CallTargetHint } from "../tool-contracts/index.js";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function short(value: unknown, max = 60): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Build a human-readable summary for an approval prompt. The summary must state
 * the exact action and target so users never approve an opaque "some action".
 */
export function describeOperation(toolName: string, input: unknown, target?: CallTargetHint): string {
  const data = asRecord(input);
  const where = target?.domain ?? target?.url ?? (typeof data.url === "string" ? data.url : undefined);

  switch (toolName) {
    case "act": {
      const steps = Array.isArray(data.steps) ? data.steps : [];
      const clickStep = steps.find((s: any) => s.do === "click");
      if (clickStep) {
        const tgt = (clickStep.target as any)?.ref ?? (clickStep.target as any)?.selector ?? (clickStep.target as any)?.name ?? (clickStep.target as any)?.label ?? "element";
        return `Click ${short(tgt)}${where ? ` on ${where}` : ""}.`;
      }
      const pressStep = steps.find((s: any) => s.do === "press" && (s.key === "Enter" || s.key === "Return"));
      if (pressStep) {
        const tgt = (pressStep.target as any)?.ref ?? (pressStep.target as any)?.selector ?? "element";
        return `Submit/Press Enter on ${short(tgt)}${where ? ` on ${where}` : ""}.`;
      }
      return `Perform ${steps.length} interaction step(s)${where ? ` on ${where}` : ""}.`;
    }
    case "submit": {
      if (data.action === "submit") {
        return `Submit form ${short(data.formRef ?? "form")}${data.expectedAction ? ` to ${short(data.expectedAction)}` : ""}${where ? ` on ${where}` : ""}.`;
      }
      if (data.action === "upload") {
        const files = Array.isArray(data.files) ? data.files.map((f: any) => f.name).join(", ") : "";
        return `Upload ${files ? short(files) : "file(s)"} to ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
      }
      if (data.action === "set_file") {
        return `Attach file ${short(data.fileId)} to ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
      }
      return `Submit action "${short(data.action)}"${where ? ` on ${where}` : ""}.`;
    }
    case "form": {
      const phase = (data.phase ?? data.action) as string;
      if (phase === "submit") {
        return `Submit form ${short(data.formRef ?? data.ref ?? "form")}${data.expectedAction ? ` to ${short(data.expectedAction)}` : ""}${where ? ` on ${where}` : ""}.`;
      }
      if (phase === "upload") {
        const files = Array.isArray(data.files) ? data.files.map((f: any) => f.name).join(", ") : "";
        return `Upload ${files ? short(files) : "file(s)"} to ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
      }
      if (phase === "set_file") {
        return `Attach file ${short(data.fileId)} to ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
      }
      if (phase === "fill") {
        const count = Array.isArray(data.fields) ? data.fields.length : (data.fields && typeof data.fields === "object" ? Object.keys(data.fields).length : 0);
        return `Fill ${count} form field(s)${where ? ` on ${where}` : ""}.`;
      }
      return `Form ${short(phase ?? "inspect")}${where ? ` on ${where}` : ""}.`;
    }
    case "data": {
      const store = short(data.domain ?? data.store ?? "data");
      const action = short(data.action ?? "access");
      if (store === "clipboard") {
        if (action === "read") return "Read the system clipboard contents.";
        if (action === "write") return `Write ${short(data.text, 80)} to the system clipboard.`;
      }
      if (action === "delete" || action === "erase") {
        return `Delete from ${store}${where ? ` on ${where}` : ""}.`;
      }
      return `${action.charAt(0).toUpperCase() + action.slice(1)} ${store}${where ? ` on ${where}` : ""}.`;
    }
    case "navigate": {
      if (data.action === "organize") {
        return `Reorganize open tabs using strategy "${short(data.strategy)}".`;
      }
      if (data.action === "save_session") {
        return `Save the current tabs as session "${short(data.title ?? "session")}".`;
      }
      if (data.action === "restore_session") {
        return `Restore session ${short(data.sessionId)} (opens saved tabs).`;
      }
      return `Navigate (${short(data.action ?? data.category ?? "open")})${where ? ` on ${where}` : ""}.`;
    }
    case "clipboard": {
      if (data.action === "read") return "Read the system clipboard contents.";
      if (data.action === "write") return `Write ${short(data.text, 80)} to the system clipboard.`;
      return "Access the system clipboard.";
    }
    case "dom.submit":
      return `Submit the form containing element ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
    case "forms.submit":
      return `Submit form ${short(data.formRef)}${data.expectedAction ? ` to ${short(data.expectedAction)}` : ""}${
        where ? ` on ${where}` : ""
      }.`;
    case "forms.upload": {
      const files = Array.isArray(data.files) ? data.files.map((f: any) => f.name).join(", ") : "";
      return `Upload ${files ? short(files) : "file(s)"} to ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
    }
    case "forms.setFile":
      return `Set file ${short(data.fileId ?? "files")} on ${short(data.selector)}${where ? ` on ${where}` : ""}.`;
    case "dom.click":
      return `Click element ${short(data.ref)}${where ? ` on ${where}` : ""}.`;
    case "downloads.start":
      return `Download ${short(data.url)}`.concat(typeof data.filename === "string" ? ` as "${short(data.filename)}"` : "");
    case "clipboard.read":
      return "Read the system clipboard contents.";
    case "clipboard.write":
      return `Write ${short(data.text, 80)} to the system clipboard.`;
    case "history.delete":
      return `Delete ${Array.isArray(data.urls) ? data.urls.length : 0} history entr(ies).`;
    case "bookmarks.delete":
      return `Delete bookmark ${short(data.id)}.`;
    case "workflows.openSequence": {
      const urls = Array.isArray(data.urls) ? data.urls.filter((url): url is string => typeof url === "string") : [];
      const shown = urls.slice(0, 5).map((url) => short(url, 80)).join(", ");
      return `Open ${urls.length} URL(s) in new tabs${shown ? `: ${shown}${urls.length > 5 ? ", …" : ""}` : ""}.`;
    }
    case "workflows.organizeTabs":
      return `Reorganize open tabs using strategy "${short(data.strategy)}".`;
    case "workflows.saveSession":
      return `Save the current tabs as session "${short(data.name)}".`;
    case "workflows.restoreSession":
      return `Restore session ${short(data.sessionId)} (opens saved tabs).`;
    default:
      return `Run ${toolName}${where ? ` on ${where}` : ""}.`;
  }
}
