import type { AiTaskKind } from "./modelRouting";

export function componentScaffoldInstruction(taskId: AiTaskKind): string {
  if (!hasComponentScaffoldGuidance(taskId)) return "";
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

export function designSystemInstruction(taskId: AiTaskKind): string {
  if (!hasDesignSystemGuidance(taskId)) return "";
  const shared = [
    "Design-system guidance: define or respect a small set of UI tokens before drafting screens — color roles, typography scale, spacing rhythm, radius, borders, shadows/elevation and interaction states.",
    "Prefer modern Tailwind-friendly structure when Tailwind is in the requested stack, with mobile-first layout, responsive grids, accessible contrast, visible focus rings and semantic landmarks.",
    "Use Lucide icons, Framer Motion micro-interactions, glass/elevation effects or advanced animation only when dependencies already exist or the reviewed plan explicitly adds them; otherwise use dependency-free SVG/CSS alternatives.",
    "Keep visual polish purposeful: loading/empty/error states, keyboard states, reduced-motion-friendly transitions and real content hierarchy are more important than decorative effects.",
    "Do not claim assets, design packages, icon libraries, motion libraries, linting or visual tests were installed or run; present them as reviewed-draft files or manual follow-up steps only.",
  ];

  switch (taskId) {
    case "vision":
      return [
        ...shared,
        "For screenshot/UI reverse engineering, derive the token palette, spacing, typography, navigation structure and component hierarchy from observable evidence before filling ambiguous areas with clearly labeled assumptions.",
      ].join("\n");
    case "architecture":
    case "planning":
      return [
        ...shared,
        "For plans, include a concise design-system section that lists tokens, reusable primitives, page templates, accessibility expectations and dependency assumptions before implementation tasks.",
      ].join("\n");
    case "coding":
    default:
      return [
        ...shared,
        "For implementation drafts, keep design tokens close to the existing stack conventions and avoid introducing a new design framework unless the user asked for it or the blueprint requires it.",
      ].join("\n");
  }
}

export function summarizeGenerationGuidance(taskId: AiTaskKind): string[] {
  return [
    "review-only drafts",
    "secret-safe placeholders",
    hasComponentScaffoldGuidance(taskId) ? "component/style guidance" : "general guidance",
    hasDesignSystemGuidance(taskId) ? "design-system guidance" : "no design-system hints",
    taskId === "planning" || taskId === "architecture" || taskId === "coding" || taskId === "vision" ? "starter blueprint hints" : "no blueprint hints",
  ];
}

export function hasComponentScaffoldGuidance(taskId: AiTaskKind): boolean {
  return taskId === "planning"
    || taskId === "architecture"
    || taskId === "coding"
    || taskId === "vision"
    || taskId === "migration";
}

export function hasDesignSystemGuidance(taskId: AiTaskKind): boolean {
  return taskId === "planning"
    || taskId === "architecture"
    || taskId === "coding"
    || taskId === "vision";
}
