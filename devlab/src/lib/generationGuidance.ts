import type { AiTaskKind } from "./modelRouting";

export function componentScaffoldInstruction(taskId: AiTaskKind): string {
  if (!shouldAttachComponentGuidance(taskId)) return "";
  const shared = [
    "Component architecture guidance: prefer small single-purpose files, explicit props/data types, clear boundaries between UI, data access, validation and side effects.",
    "For TypeScript projects, favor strict interfaces/types, typed API contracts, narrow component props and custom hooks for reusable stateful behavior.",
    "State management guidance: use local state first; introduce TanStack Query, Zustand or similar libraries only when the project already includes them or the blueprint/plan explicitly adds them.",
    "Style-guide defaults: keep naming consistent, include sensible loading/empty/error states, preserve accessibility labels/focus order, and mention lint/test/config files as reviewed draft artifacts or manual checklist items only.",
    "Do not claim linting, formatting, tests, accessibility checks or package installs have run; suggest backend-owned verification profiles or manual commands for the user to run explicitly after reviewed apply.",
  ];

  switch (taskId) {
    case "vision":
      return [
        ...shared,
        "For UI reconstruction, split layout shell, reusable visual primitives and page-specific sections so the reviewed draft can be inspected file by file.",
      ].join("\n");
    case "architecture":
    case "planning":
      return [
        ...shared,
        "For plans, include component boundaries, data-flow notes, file ownership, risk notes and a verification checklist instead of a monolithic implementation prompt.",
      ].join("\n");
    case "migration":
      return [
        ...shared,
        "For migration/API drafts, separate schema changes, server handlers, validation schemas and rollout/checklist notes so each file remains reviewable.",
      ].join("\n");
    case "coding":
    default:
      return shared.join("\n");
  }
}

export function summarizeGenerationGuidance(taskId: AiTaskKind): string[] {
  return [
    "review-only drafts",
    "secret-safe placeholders",
    componentScaffoldInstruction(taskId) ? "component/style guidance" : "general guidance",
    taskId === "planning" || taskId === "architecture" || taskId === "coding" || taskId === "vision" ? "starter blueprint hints" : "no blueprint hints",
  ];
}

function shouldAttachComponentGuidance(taskId: AiTaskKind): boolean {
  return taskId === "planning"
    || taskId === "architecture"
    || taskId === "coding"
    || taskId === "vision"
    || taskId === "migration";
}
