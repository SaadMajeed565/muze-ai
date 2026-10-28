/**
 * Phase C task tests (OpenCode adoption plan §6, Phase C): view-only
 * compaction, output-only pruning with protected records, child tasks
 * (isolated context, no child-of-child recursion), skill catalog
 * progressive disclosure, and global-then-domain instruction notes.
 * Mock executor only — no live browser, no gateway, no model calls.
 * Domains used here are generic placeholders (example.com /
 * example.org), never real sites the user uses.
 */
import { describe, expect, it } from "vitest";
import {
  TaskRunner,
  createMemoryTaskStore,
  type PolicySnapshot,
  type TaskRecord,
  type TaskStep,
} from "../libs/tasks/index.js";
import { SkillCatalog } from "../libs/skills/index.js";
import { InstructionNotes, combinedInstructionText, resolveInstructionNotes } from "../libs/instructions/index.js";

const CLIENT = "client-a";
const SESSION = "browser-session-1";

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `task_${idCounter.toString(16).padStart(32, "0")}`;
}

function makeRunner() {
  const store = createMemoryTaskStore();
  const snapshot: PolicySnapshot = { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" };
  const runner = new TaskRunner({
    store,
    executeStep: async (tool: string, _input: Record<string, unknown>, ctx: { stepIndex: number }) => ({
      outputSummary: `output for ${tool} step ${ctx.stepIndex} `.padEnd(120, "x"),
    }),
    audit: () => undefined,
    progress: () => undefined,
    policySnapshot: () => ({ ...snapshot }),
    now: () => 1_000_000,
    generateId: nextId,
    isConsequential: (tool) => tool === "dom.click",
    captureSnapshot: async () => ({ url: "https://example.com/page", a11ySummary: "a11y", formSummary: "form" }),
    postStepObserve: async () => ({ url: "https://example.com/expected", targetPresent: true, summary: "observed expected page" }),
  });
  return { runner, store, snapshot };
}

function findTask(store: ReturnType<typeof createMemoryTaskStore>, id: string): TaskRecord {
  const task = store.snapshot().find((t) => t.id === id);
  if (!task) throw new Error(`task not found in store: ${id}`);
  return task;
}

describe("Phase C: compaction is view-only", () => {
  it("compacted view replaces old steps with summary counts while raw records survive", async () => {
    idCounter = 0;
    const { runner, store } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "six reads",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: Array.from({ length: 6 }, () => ({ tool: "tabs.list", input: {} })),
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    await runner.runTask(created.id, CLIENT);
    const compacted = await runner.compactTaskView(created.id, CLIENT, { tailSteps: 2 });
    expect(compacted.compacted).toBe(true);
    expect(compacted.steps.map((s) => s.index)).toEqual([4, 5]);
    expect(compacted.coveredStepIndices).toEqual([0, 1, 2, 3]);
    expect(compacted.covered.done).toEqual([0, 1, 2, 3]);
    expect(compacted.covered.failed).toEqual([]);
    expect(compacted.status).toBe("done");
    // Raw records survive: getTask and the store still list all steps.
    const full = await runner.getTask(created.id, CLIENT);
    expect(full.steps).toHaveLength(6);
    expect(findTask(store, created.id).steps).toHaveLength(6);
    expect(findTask(store, created.id).steps[0].outputSummary).not.toBe("");
  });
});

describe("Phase C: pruning is output-only with protected records", () => {
  it("keeps checkpoints, the latest verify record, and the protected tail; never changes state, outcome, or verify result", async () => {
    idCounter = 0;
    const { runner, store } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "reads plus one verified click",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [
          { tool: "tabs.list", input: {} },
          { tool: "dom.click", input: { ref: "r1" }, verify: { kind: "url-equals", value: "https://example.com/expected" } },
          { tool: "tabs.list", input: {} },
          { tool: "tabs.list", input: {} },
          { tool: "tabs.list", input: {} },
          { tool: "tabs.list", input: {} },
        ],
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    const ran = await runner.runTask(created.id, CLIENT);
    expect(ran.status).toBe("done");
    expect(ran.steps[1].verifyOutcome).toBe("pass");
    expect(findTask(store, created.id).steps[1].preStepSnapshot).not.toBeNull();

    const pruned = await runner.pruneTask(created.id, CLIENT, { tailSteps: 2, minReclaimChars: 10 });
    expect(pruned.applied).toBe(true);
    // Steps 0, 2, 3 pruned; step 1 protected (checkpoint + latest
    // verify); steps 4, 5 protected (tail).
    expect(pruned.prunedStepIndices).toEqual([0, 2, 3]);
    const after = findTask(store, created.id);
    expect(after.steps[0].outputSummary).toBe("");
    expect(after.steps[2].outputSummary).toBe("");
    expect(after.steps[3].outputSummary).toBe("");
    expect(after.steps[1].outputSummary).not.toBe("");
    expect(after.steps[4].outputSummary).not.toBe("");
    expect(after.steps[5].outputSummary).not.toBe("");
    // Output-only: state, verify, checkpoint, status all unchanged.
    expect(after.status).toBe("done");
    expect(after.steps.every((s: TaskStep) => s.state === "done")).toBe(true);
    expect(after.steps[1].verifyOutcome).toBe("pass");
    expect(after.steps[1].preStepSnapshot).not.toBeNull();
    expect(after.steps[1].input).toEqual({ ref: "r1" });
  });

  it("keeps the plan approval and policy snapshot when pruning applies", async () => {
    idCounter = 0;
    const { runner, store } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "approved reads",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: Array.from({ length: 4 }, () => ({ tool: "tabs.list", input: {} })),
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    await runner.approvePlan(created.id, CLIENT, { source: "dashboard" });
    await runner.runTask(created.id, CLIENT);
    const before = findTask(store, created.id);
    expect(before.planApproval).not.toBeNull();
    const pruned = await runner.pruneTask(created.id, CLIENT, { tailSteps: 1, minReclaimChars: 10 });
    expect(pruned.applied).toBe(true);
    const after = findTask(store, created.id);
    expect(after.planApproval).toEqual(before.planApproval);
    expect(after.policySnapshot).toEqual(before.policySnapshot);
  });

  it("does nothing below the reclaim threshold", async () => {
    idCounter = 0;
    const { runner, store } = makeRunner();
    const created = await runner.createTask(
      {
        goal: "tiny outputs",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "tabs.list", input: {} }],
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    await runner.runTask(created.id, CLIENT);
    const before = findTask(store, created.id).steps[0].outputSummary;
    const pruned = await runner.pruneTask(created.id, CLIENT, { tailSteps: 0, minReclaimChars: 1_000_000 });
    expect(pruned.applied).toBe(false);
    expect(pruned.prunedStepIndices).toEqual([]);
    expect(findTask(store, created.id).steps[0].outputSummary).toBe(before);
  });
});

describe("Phase C: child tasks", () => {
  it("child context is isolated from the parent's steps and goal; parent is unaffected and its mode/policy/plan unchanged", async () => {
    idCounter = 0;
    const { runner, store } = makeRunner();
    const parent = await runner.createTask(
      {
        goal: "parent goal unique-marker",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "windows.list", input: { marker: "parent-only" } }],
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    const parentBefore = findTask(store, parent.id);
    const childSnapshot: PolicySnapshot = { policyVersion: 2, mode: "default", clientId: CLIENT, scope: "call:tools" };
    const child = await runner.createChildTask(
      parent.id,
      CLIENT,
      { goal: "child goal", steps: [{ tool: "tabs.list", input: {} }], mode: "explore" },
      childSnapshot,
    );
    expect(child.mode).toBe("explore");
    // Parent record byte-identical after child creation.
    expect(findTask(store, parent.id)).toEqual(parentBefore);
    const childRecord = findTask(store, child.id);
    expect(childRecord.parentId).toBe(parent.id);
    expect(childRecord.browserSessionId).toBe(parent.browserSessionId);
    expect(childRecord.policySnapshot.policyVersion).toBe(2);
    expect(childRecord.planApproval).toBeNull();
    // Isolation: child context carries only the child's own record.
    const context = await runner.getChildContext(child.id, CLIENT);
    expect(context.parentId).toBe(parent.id);
    expect(context.goal).toBe("child goal");
    expect(context.steps.map((s) => s.tool)).toEqual(["tabs.list"]);
    expect(JSON.stringify(context)).not.toContain("parent goal unique-marker");
    expect(JSON.stringify(context)).not.toContain("windows.list");
    // getChildContext on a top-level task is rejected.
    await expect(runner.getChildContext(parent.id, CLIENT)).rejects.toThrow(/not a child task/);
  });

  it("a child task cannot create a child: denied with a clear error, parent unaffected, nothing created", async () => {
    idCounter = 0;
    const { runner, store } = makeRunner();
    const parent = await runner.createTask(
      {
        goal: "parent",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "tabs.list", input: {} }],
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    const child = await runner.createChildTask(
      parent.id,
      CLIENT,
      { goal: "child", steps: [{ tool: "tabs.list", input: {} }], mode: "explore" },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    const countBefore = store.snapshot().length;
    const parentBefore = findTask(store, parent.id);
    const childBefore = findTask(store, child.id);
    await expect(
      runner.createChildTask(
        child.id,
        CLIENT,
        { goal: "grandchild", steps: [{ tool: "tabs.list", input: {} }], mode: "explore" },
        { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
      ),
    ).rejects.toThrow(/cannot create children/);
    expect(store.snapshot()).toHaveLength(countBefore);
    expect(findTask(store, parent.id)).toEqual(parentBefore);
    expect(findTask(store, child.id)).toEqual(childBefore);
  });

  it("child mode must be explore or summary, never guessed", async () => {
    idCounter = 0;
    const { runner } = makeRunner();
    const parent = await runner.createTask(
      {
        goal: "parent",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "tabs.list", input: {} }],
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    await expect(
      runner.createChildTask(
        parent.id,
        CLIENT,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { goal: "child", steps: [{ tool: "tabs.list", input: {} }], mode: "act" as any },
        { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
      ),
    ).rejects.toThrow(/child mode must be explore or summary/);
  });

  it("an explore child runs read-only steps under its own mode", async () => {
    idCounter = 0;
    const { runner } = makeRunner();
    const parent = await runner.createTask(
      {
        goal: "parent",
        clientId: CLIENT,
        browserSessionId: SESSION,
        steps: [{ tool: "tabs.list", input: {} }],
      },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    const child = await runner.createChildTask(
      parent.id,
      CLIENT,
      { goal: "explore child", steps: [{ tool: "tabs.list", input: {} }], mode: "explore" },
      { policyVersion: 1, mode: "default", clientId: CLIENT, scope: "call:tools" },
    );
    const ran = await runner.runTask(child.id, CLIENT);
    expect(ran.status).toBe("done");
    expect(ran.steps[0].state).toBe("done");
  });
});

describe("Phase C: skill catalog progressive disclosure", () => {
  it("catalog returns name+description only; full text only on explicit load-by-id; denied skills are hidden and load-rejected", () => {
    const catalog = new SkillCatalog();
    expect(catalog.listCatalog()).toEqual([]);
    catalog.register({
      id: "read-and-extract",
      name: "Read and extract",
      description: "Read a page and extract structured data for review.",
      body: "FULL-BODY-MARKER read the page, extract the requested fields, return them for review.",
    });
    catalog.register({
      id: "fill-for-review",
      name: "Fill for review",
      description: "Fill a form for review without submitting it.",
      body: "FULL-BODY-MARKER fill the form fields, stop before submit, show a preview.",
    });
    // Tier 1: no body key anywhere in the catalog, and no body text.
    const entries = catalog.listCatalog();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["description", "id", "name"]);
      expect("body" in entry).toBe(false);
    }
    expect(JSON.stringify(entries)).not.toContain("FULL-BODY-MARKER");
    // Tier 2: explicit load-by-id returns the full body.
    expect(catalog.load("read-and-extract").body).toContain("FULL-BODY-MARKER");
    expect(catalog.load("read-and-extract").description).toBe("Read a page and extract structured data for review.");
    // Unknown ids fail closed, never guessed.
    expect(() => catalog.load("read-and-extract-typo")).toThrow(/unknown skill/);
    // Deny hides from the catalog and rejects loading.
    catalog.deny("fill-for-review");
    expect(catalog.listCatalog().map((e) => e.id)).toEqual(["read-and-extract"]);
    expect(() => catalog.load("fill-for-review")).toThrow(/denied/);
  });
});

describe("Phase C: instruction notes combine global-then-domain", () => {
  const notes = new InstructionNotes();
  notes.addNote({ id: "g1", scope: "global", text: "GLOBAL-ONE ground before acting." });
  notes.addNote({ id: "g2", scope: "global", text: "GLOBAL-TWO verify after consequential steps." });
  notes.addNote({ id: "d1", scope: "domain", domain: "example.com", text: "DOMAIN-EXAMPLE preview before submitting on this domain." });
  notes.addNote({ id: "d2", scope: "domain", domain: "*.example.org", text: "DOMAIN-ORG preview before submitting on this domain." });

  it("resolves global notes first, then matching domain notes, combined not override", () => {
    const resolved = resolveInstructionNotes(notes.listNotes(), "example.com");
    expect(resolved.map((n) => n.id)).toEqual(["g1", "g2", "d1"]);
    const combined = combinedInstructionText(notes.listNotes(), "example.com");
    expect(combined.indexOf("GLOBAL-ONE")).toBeLessThan(combined.indexOf("DOMAIN-EXAMPLE"));
    expect(combined).toContain("GLOBAL-TWO");
    expect(combined).toContain("DOMAIN-EXAMPLE");
  });

  it("domain notes load only for matching domains; glob matches subdomains; no domain means globals only", () => {
    expect(notes.resolve("sub.example.org").map((n) => n.id)).toEqual(["g1", "g2", "d2"]);
    expect(notes.resolve("unrelated.test").map((n) => n.id)).toEqual(["g1", "g2"]);
    expect(notes.resolve().map((n) => n.id)).toEqual(["g1", "g2"]);
    expect(notes.resolve("example.org").map((n) => n.id)).toEqual(["g1", "g2", "d2"]);
  });

  it("rejects malformed notes instead of guessing", () => {
    const store = new InstructionNotes();
    expect(() => store.addNote({ id: "x", scope: "domain", text: "no domain" })).toThrow(/domain/);
    expect(() => store.addNote({ id: "x", scope: "global", domain: "example.com", text: "global with domain" })).toThrow(/global/);
    store.addNote({ id: "x", scope: "global", text: "ok" });
    expect(() => store.addNote({ id: "x", scope: "global", text: "duplicate" })).toThrow(/already exists/);
  });
});
