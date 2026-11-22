import assert from "node:assert/strict";
import test from "node:test";
import { parseExecutionPlan, extractTextFromParts } from "../src/engine/planner.ts";
import { PetSpriteRegistry } from "../src/engine/pets.ts";
import { parseMarkdownBlocks } from "../src/ui/markdown.ts";

test("parseExecutionPlan extracts JSON array from fenced markdown", () => {
  const parts = [
    {
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "text" as const,
      text: [
        "Here is the execution plan:",
        "```json",
        JSON.stringify([
          {
            id: "api",
            role: "coder",
            title: "Build API routes",
            prompt: "Implement REST endpoints",
            branch_or_scope: "src/api/",
          },
          {
            id: "tests",
            role: "tester",
            title: "Write unit tests",
            prompt: "Add unit tests for API",
            branch_or_scope: "tests/",
          },
        ]),
        "```",
      ].join("\n"),
    },
  ];

  const plan = parseExecutionPlan(parts, "Build API and tests");
  assert.equal(plan.length, 2);
  assert.equal(plan[0].id, "api");
  assert.equal(plan[0].role, "Coder");
  assert.equal(plan[1].title, "Write unit tests");
});

test("parseExecutionPlan falls back cleanly on malformed output", () => {
  const parts = [
    {
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "text" as const,
      text: "Sorry, not JSON at all [broken",
    },
  ];
  const plan = parseExecutionPlan(parts, "Refactor module X");
  assert.equal(plan.length, 1);
  assert.equal(plan[0].prompt, "Refactor module X");
  assert.equal(plan[0].role, "coder");
});

test("extractTextFromParts ignores non-text parts", () => {
  const text = extractTextFromParts([
    {
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "text",
      text: "Hello",
    },
    {
      id: "p2",
      sessionID: "s1",
      messageID: "m1",
      type: "reasoning",
      text: "Secret",
      time: { start: 0 },
    },
  ]);
  assert.equal(text, "Hello");
});

test("PetSpriteRegistry resolves exact, fuzzy, empty-role, and fallback states", () => {
  const registry = new PetSpriteRegistry();
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: {
      idle: "orch-idle",
      work: "orch-work",
      alert: "orch-alert",
      error: "orch-error",
    },
    subagents: {
      default: {
        idle: "def-idle",
        walk: "def-walk",
        work: "def-work",
        alert: "def-alert",
      },
      coder: {
        idle: "coder-idle",
        work: "coder-work",
      },
    },
  });

  assert.equal(registry.resolveSpriteUrl("orchestrator", "orchestrator", "walk"), "orch-work");
  assert.equal(registry.resolveSpriteUrl("subagent", "coder", "work"), "coder-work");
  assert.equal(registry.resolveSpriteUrl("subagent", "coder", "walk"), "coder-work");
  assert.equal(registry.resolveSpriteUrl("subagent", "senior-coder", "idle"), "coder-idle");
  // Empty role must not fuzzy-match 'coder'
  assert.equal(registry.resolveSpriteUrl("subagent", "", "idle"), "def-idle");
  // Missing error sprite falls back to alert -> idle
  assert.equal(registry.resolveSpriteUrl("subagent", "unknown", "error"), "def-alert");
  // Missing fall sprite falls back to alert -> idle; sit/sleep/happy fall back to idle
  assert.equal(registry.resolveSpriteUrl("subagent", "unknown", "fall"), "def-alert");
  assert.equal(registry.resolveSpriteUrl("subagent", "unknown", "sit"), "def-idle");
  assert.equal(registry.resolveSpriteUrl("subagent", "unknown", "sleep"), "def-idle");
  assert.equal(registry.resolveSpriteUrl("subagent", "unknown", "happy"), "def-idle");
});

test("PetSpriteRegistry resolves numbered multi-frame animation sequences", () => {
  const registry = new PetSpriteRegistry();
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: {
      idle: "idle-1",
      idle_1: "idle-1",
      idle_2: "idle-2",
      idle_3: "idle-3",
      walk_1: "walk-1",
      walk_2: "walk-2",
      walk_3: "walk-3",
    },
    subagents: { default: { idle: "sub-idle" } },
  });

  assert.deepEqual(registry.resolveSpriteFrames("orchestrator", "orchestrator", "idle"), [
    "idle-1",
    "idle-2",
    "idle-3",
  ]);
  // Idle blink window (2600..2780ms) hits idle_2
  assert.equal(registry.resolveAnimatedSpriteUrl("orchestrator", "orchestrator", "idle", 2650), "idle-2");
  // Walk ping-pong: [0, 1, 2, 1] at 190ms intervals
  assert.equal(registry.resolveAnimatedSpriteUrl("orchestrator", "orchestrator", "walk", 0), "walk-1");
  assert.equal(registry.resolveAnimatedSpriteUrl("orchestrator", "orchestrator", "walk", 200), "walk-2");
  assert.equal(registry.resolveAnimatedSpriteUrl("orchestrator", "orchestrator", "walk", 400), "walk-3");
  assert.equal(registry.resolveAnimatedSpriteUrl("orchestrator", "orchestrator", "walk", 600), "walk-2");
});

test("parseMarkdownBlocks splits headings, lists, code fences, and paragraphs", () => {
  const md = [
    "### Plan",
    "",
    "**Plan mode** steps:",
    "- Inspect `src/main.ts`",
    "- Run tests",
    "",
    "```bash",
    "npm test",
    "```",
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].text, "Plan");
  assert.equal(blocks[1].type, "paragraph");
  assert.equal(blocks[2].type, "ul");
  assert.deepEqual(blocks[2].items, ["Inspect `src/main.ts`", "Run tests"]);
  assert.equal(blocks[3].type, "code");
  assert.equal(blocks[3].lang, "bash");
  assert.equal(blocks[3].text, "npm test");
});

test("PetSpriteRegistry resolves 5-state productive Glegle sprites and fallbacks", () => {
  const registry = new PetSpriteRegistry();
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: {
      idle: "orch-idle",
      work: "orch-work",
    },
    subagents: {
      default: {
        idle: "def-idle",
        work: "def-work",
        sleep: "def-sleep",
        alert: "def-alert",
        happy: "def-happy",
      },
      "glegle-1": {
        idle: "g1-idle",
        work: "g1-work",
        sleep: "g1-sleep",
        alert: "g1-alert",
        happy: "g1-happy",
      },
    },
  });

  // Exact 5 productive states resolve directly
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "idle"), "g1-idle");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "work"), "g1-work");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "sleep"), "g1-sleep");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "alert"), "g1-alert");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "happy"), "g1-happy");

  // Missing legacy/extended states fall back cleanly
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "walk"), "g1-work");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "fall"), "g1-alert");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "sit"), "g1-idle");
  assert.equal(registry.resolveSpriteUrl("subagent", "glegle-1", "error"), "g1-alert");
});

test("PetSpriteRegistry discovers and rotates across multi-variant Glegle subagents", () => {
  const registry = new PetSpriteRegistry();

  // Multi-variant pack with glegle-1 and glegle-2 alongside default
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: { idle: "orch-idle" },
    subagents: {
      default: { idle: "def-idle", work: "def-work", sleep: "def-sleep", alert: "def-alert", happy: "def-happy" },
      "glegle-2": { idle: "g2-idle", work: "g2-work", sleep: "g2-sleep", alert: "g2-alert", happy: "g2-happy" },
      "glegle-1": { idle: "g1-idle", work: "g1-work", sleep: "g1-sleep", alert: "g1-alert", happy: "g1-happy" },
    },
  });

  assert.deepEqual(registry.listSubagentVariants(), ["default", "glegle-1", "glegle-2"]);
  assert.equal(registry.pickSubagentVariant("Execution", 0), "glegle-1");
  assert.equal(registry.pickSubagentVariant("Execution", 1), "glegle-2");
  assert.equal(registry.pickSubagentVariant("Execution", 2), "glegle-1");

  // Explicit role folder (e.g. research) matches when present
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: { idle: "orch-idle" },
    subagents: {
      default: { idle: "def-idle" },
      "glegle-1": { idle: "g1-idle" },
      "glegle-2": { idle: "g2-idle" },
      research: { idle: "res-idle" },
    },
  });
  assert.equal(registry.pickSubagentVariant("Research", 0), "research");
  assert.equal(registry.pickSubagentVariant("Senior Research", 1), "research");

  // Single default pack falls back to default
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: { idle: "orch-idle" },
    subagents: {
      default: { idle: "def-idle" },
    },
  });
  assert.deepEqual(registry.listSubagentVariants(), ["default"]);
  assert.equal(registry.pickSubagentVariant("Execution", 0), "default");
});
