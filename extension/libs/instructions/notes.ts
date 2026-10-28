/**
 * Phase C per-domain instruction notes (OpenCode adoption plan §6,
 * Phase C; OpenCode's AGENTS.md rule applied to domains instead of
 * directories).
 *
 * Ordering — global first, then domain, COMBINED not override: a
 * domain note never replaces a global note; both are returned, global
 * notes in insertion order followed by matching domain notes in
 * insertion order. This matches OpenCode's "combines the files and
 * does not resolve conflicts between them".
 *
 * Scoping: domain notes apply only when a tab's domain matches the
 * note's domain pattern (exact host, or a `*.example.com` glob that
 * also matches the bare host, reusing the task bounds matcher). They
 * are generic guidance about HOW to work, never a procedure for a
 * specific site flow (plan §8) — that rule is enforced at note-
 * creation time by the caller; this module carries no site content,
 * and its tests use only clearly generic placeholder domains.
 *
 * Lifetime: notes resolved for a task are the notes in force when
 * that task's instruction set is assembled. Updating a note applies
 * to the NEXT task assembled after the update, never to a running
 * task (running tasks keep their pinned policy snapshot and
 * instruction set, as in Phase B).
 */
import { domainMatches } from "../tasks/types.js";

export interface InstructionNote {
  id: string;
  scope: "global" | "domain";
  /** Required for domain notes (a host or `*.host` glob); absent for global notes. */
  domain?: string;
  text: string;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`instruction note rejected: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Pure resolution: global notes first (insertion order), then notes
 * whose domain pattern matches `domain` (insertion order). A domain
 * note never overrides or removes a global note.
 */
export function resolveInstructionNotes(notes: InstructionNote[], domain?: string): InstructionNote[] {
  const host = typeof domain === "string" ? domain.toLowerCase() : null;
  const globals = notes.filter((note) => note.scope === "global");
  const matching =
    host === null
      ? []
      : notes.filter((note) => note.scope === "domain" && note.domain !== undefined && domainMatches(host, note.domain));
  return [...globals, ...matching];
}

/** Combined text of the resolved notes, in global-then-domain order. */
export function combinedInstructionText(notes: InstructionNote[], domain?: string): string {
  return resolveInstructionNotes(notes, domain)
    .map((note) => note.text)
    .join("\n\n");
}

export class InstructionNotes {
  private notes: InstructionNote[] = [];

  /** Add a note. Duplicate ids are rejected, never overwritten. */
  addNote(note: InstructionNote): void {
    const id = requireNonEmpty(note.id, "id");
    const text = requireNonEmpty(note.text, "text");
    if (this.notes.some((existing) => existing.id === id)) {
      throw new Error(`instruction note rejected: note "${id}" already exists`);
    }
    if (note.scope === "domain") {
      const domain = requireNonEmpty(note.domain, "domain");
      this.notes.push({ id, scope: "domain", domain, text });
    } else if (note.scope === "global") {
      if (note.domain !== undefined) throw new Error("instruction note rejected: a global note must not carry a domain");
      this.notes.push({ id, scope: "global", text });
    } else {
      throw new Error(`instruction note rejected: unknown scope "${String(note.scope)}"`);
    }
  }

  /** Remove a note by id; returns false when no such note exists. */
  removeNote(id: string): boolean {
    const before = this.notes.length;
    this.notes = this.notes.filter((note) => note.id !== id);
    return this.notes.length !== before;
  }

  listNotes(): InstructionNote[] {
    return this.notes.map((note) => ({ ...note }));
  }

  resolve(domain?: string): InstructionNote[] {
    return resolveInstructionNotes(this.notes, domain);
  }

  combinedText(domain?: string): string {
    return combinedInstructionText(this.notes, domain);
  }
}
