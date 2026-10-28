/**
 * Phase C skills, progressive disclosure (OpenCode adoption plan §6,
 * Phase C). A skill is a record with an id, name, description, and a
 * body stored in the extension. This module is the disclosure boundary:
 *
 * - Tier 1 (catalog): listCatalog() returns name + description ONLY.
 *   The body is never included, so a catalog listing can never leak
 *   full skill text into an initialize payload, a ListTools response,
 *   or tool guidance.
 * - Tier 2 (load): load() returns the full body ONLY for an explicitly
 *   requested id. Supporting files are never auto-loaded; a client
 *   reads them only if the loaded body directs it to.
 * - Deny hides AND rejects: deny(id) removes the skill from the
 *   catalog and makes load(id) fail, mirroring OpenCode's skill
 *   permission rule (deny = hidden from the model and rejected on
 *   load). Denial is a disclosure control only — loading a skill
 *   never approves a browser action, and a skill body never changes
 *   scope, policy, or approvals.
 *
 * The catalog starts EMPTY. There is no seeded skill content in this
 * module: skills are registered by the host/dashboard seeding path
 * (a future wiring step — see the Phase C report), never invented
 * here. Registering a skill with a site-specific procedure would be a
 * bug, not a feature (plan §8: no per-task hardcoded prompts, no
 * site-specific procedures in skills); this module does not validate
 * content, so that rule is enforced at registration time by the
 * caller, and the catalog itself carries no site content.
 */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
}

export interface SkillRecord extends SkillCatalogEntry {
  /** Full skill text; returned only by load(), never by listCatalog(). */
  body: string;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`skill registration rejected: ${field} must be a non-empty string`);
  }
  return value;
}

export class SkillCatalog {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly denied = new Set<string>();

  /** Register a skill. Duplicate ids are rejected, never overwritten. */
  register(skill: SkillRecord): void {
    const id = requireNonEmpty(skill.id, "id");
    requireNonEmpty(skill.name, "name");
    requireNonEmpty(skill.description, "description");
    requireNonEmpty(skill.body, "body");
    if (this.skills.has(id)) throw new Error(`skill registration rejected: skill "${id}" is already registered`);
    this.skills.set(id, { id, name: skill.name, description: skill.description, body: skill.body });
  }

  /** Deny a skill id: hidden from the catalog and rejected on load. */
  deny(id: string): void {
    this.denied.add(requireNonEmpty(id, "id"));
  }

  isDenied(id: string): boolean {
    return this.denied.has(id);
  }

  /**
   * Tier 1 catalog: id + name + description only, denied ids excluded.
   * The returned objects never carry a `body` key.
   */
  listCatalog(): SkillCatalogEntry[] {
    return [...this.skills.values()]
      .filter((skill) => !this.denied.has(skill.id))
      .map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }));
  }

  /**
   * Tier 2 load-by-id only: full body for one explicitly requested id.
   * Denied ids are rejected even when registered; unknown ids fail
   * closed instead of returning a nearest match (ids are never
   * guessed, mirroring the mode rule).
   */
  load(id: string): SkillRecord {
    if (typeof id !== "string" || id === "") throw new Error("skill load rejected: id must be a non-empty string");
    if (this.denied.has(id)) throw new Error(`skill load denied: skill "${id}" is denied`);
    const skill = this.skills.get(id);
    if (!skill) throw new Error(`skill load rejected: unknown skill "${id}"`);
    return { ...skill };
  }
}
