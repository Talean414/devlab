import { projectTemplates } from "../data/templates";
import type { AiTaskKind } from "./modelRouting";

const STARTER_BLUEPRINT_IDS = [
  "next-app",
  "vite-react-ts",
  "next-prisma",
  "monorepo",
  "node-api",
  "hono",
  "rust-axum",
  "docker-compose",
  "tauri-desktop",
] as const;

interface StarterBlueprintProfile {
  id: string;
  name: string;
  stack: string;
  language: string;
  description: string;
  tags: string[];
}

export function starterBlueprintInstruction(taskId: AiTaskKind): string {
  if (!shouldAttachStarterBlueprints(taskId)) {
    return "";
  }
  const profiles = starterBlueprintProfiles();
  if (profiles.length === 0) return "";
  const summary = profiles
    .map((profile) => `- ${profile.id}: ${profile.name} (${profile.stack}, ${profile.language}) — ${profile.description}; tags: ${profile.tags.join(", ")}`)
    .join("\n");

  return [
    "Starter blueprint guidance: use these existing DevLab template profiles as metadata-only planning hints when the user's request matches them.",
    summary,
    "Blueprint commands are references for human review only. Do not imply they ran, do not add hidden install steps, and keep generated files as reviewed drafts until explicit Editor apply.",
    "When using a blueprint, align file paths, package boundaries, config files and README/setup notes with that stack instead of mixing unrelated conventions.",
  ].join("\n");
}

function shouldAttachStarterBlueprints(taskId: AiTaskKind): boolean {
  return taskId === "planning" || taskId === "architecture" || taskId === "coding" || taskId === "vision";
}

function starterBlueprintProfiles(): StarterBlueprintProfile[] {
  const byId = new Map(projectTemplates.map((template) => [template.id, template]));
  return STARTER_BLUEPRINT_IDS.flatMap((id) => {
    const template = byId.get(id);
    if (!template) return [];
    return [{
      id: template.id,
      name: template.name,
      stack: template.stack,
      language: template.lang || "mixed",
      description: template.description,
      tags: template.tags.slice(0, 6),
    }];
  });
}
