import type { Part, SessionMessageAssistant } from "@opencode-ai/sdk/v2/client";
import type { SubtaskPlanItem } from "./types";

export const PLANNER_SYSTEM_PROMPT = `You are Boymoder's task planner.
Your ONLY job right now is to decompose the user's goal into 1 to 4 independent, non-overlapping subtasks that parallel worker pets can execute.
Do NOT edit files or run tools during planning.
Return ONLY a valid JSON array matching this exact schema:
[
  {
    "id": "subtask-1",
    "role": "Research",
    "title": "Short 2-5 word title",
    "prompt": "Detailed, self-contained instructions for this worker.",
    "branch_or_scope": "target/files/or/module"
  }
]
Choose a short, clear 1-word pet name for "role" reflecting what the pet is doing, such as "Research", "Execution", "Testing", "Review", "Frontend", "Backend", "Refactor", or "Docs".
Ensure subtasks do not touch the exact same files unless they are read-only.`;

export function buildPlannerPrompt(goal: string, workspaceDir: string, isGitRepo: boolean): string {
  return [
    `Workspace directory: ${workspaceDir || "(none selected yet)"}`,
    `Git repository: ${isGitRepo ? "yes (parallel tasks may run in isolated worktrees)" : "no"}`,
    `User Goal: ${goal}`,
    "",
    "Respond ONLY with the JSON execution plan array.",
  ].join("\n");
}

export function extractTextFromParts(parts: Part[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function extractTextFromV2Content(
  content: SessionMessageAssistant["content"] | undefined
): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is Extract<SessionMessageAssistant["content"][number], { type: "text" }> =>
        item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function findJsonArraySubstring(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw.trim();

  const start = candidate.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          return candidate.slice(start, i + 1);
        }
      }
    }
  }
  return null;
}

export function parseExecutionPlan(
  source: Part[] | string | undefined,
  fallbackGoal: string
): SubtaskPlanItem[] {
  const text = typeof source === "string" ? source : extractTextFromParts(source);
  const jsonSlice = findJsonArraySubstring(text);
  if (!jsonSlice) {
    return [
      {
        id: "subtask-1",
        role: "coder",
        title: "Execute Goal",
        prompt: fallbackGoal,
        branch_or_scope: "workspace",
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return [
      {
        id: "subtask-1",
        role: "coder",
        title: "Execute Goal",
        prompt: fallbackGoal,
        branch_or_scope: "workspace",
      },
    ];
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [
      {
        id: "subtask-1",
        role: "coder",
        title: "Execute Goal",
        prompt: fallbackGoal,
        branch_or_scope: "workspace",
      },
    ];
  }

  return parsed.slice(0, 6).map((item, idx): SubtaskPlanItem => {
    const rec = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `subtask-${idx + 1}`;
    const rawRole = typeof rec.role === "string" && rec.role.trim() ? rec.role.trim() : "Execution";
    const role = rawRole.charAt(0).toUpperCase() + rawRole.slice(1);
    const title = typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : `Task ${idx + 1}`;
    const prompt = typeof rec.prompt === "string" && rec.prompt.trim() ? rec.prompt.trim() : fallbackGoal;
    const scope = typeof rec.branch_or_scope === "string" ? rec.branch_or_scope.trim() : undefined;
    return { id, role, title, prompt, branch_or_scope: scope };
  });
}
