import type { TestProfile } from "./testRunner";

/**
 * Pure, renderer-side helpers that match already-discovered backend-owned test
 * profiles to affected workspace paths. They never execute anything: callers
 * obtain profiles from the read-only `test_runner_snapshot` command and run a
 * profile only through the explicit Self-Healing Tests flow.
 */

export interface VerificationProfileRecommendation {
  id: string;
  label: string;
  command: string;
  reason: string;
  matchedDraftPaths: string[];
}

export function recommendVerificationProfiles(
  profiles: TestProfile[],
  affectedPaths: string[],
): VerificationProfileRecommendation[] {
  const scored = profiles.map((profile) => {
    const score = verificationProfileScore(profile, affectedPaths);
    return { profile, score };
  }).filter((item) => item.score > 0);

  const candidates = scored.length > 0
    ? scored.sort((left, right) => right.score - left.score || left.profile.label.localeCompare(right.profile.label))
    : profiles.map((profile) => ({ profile, score: 1 }));

  return candidates.slice(0, 6).map(({ profile }) => ({
    id: profile.id,
    label: profile.label,
    command: profile.command,
    reason: profile.reason,
    matchedDraftPaths: affectedPaths.filter((path) => profileMatchesPath(profile, path)).slice(0, 12),
  }));
}

export function verificationProfileScore(profile: TestProfile, affectedPaths: string[]): number {
  let score = 0;
  for (const path of affectedPaths) {
    if (profileMatchesPath(profile, path)) score += 3;
  }
  const command = profile.command.toLowerCase();
  if (/\b(test|check|typecheck|pytest|cargo|go test|vitest|jest)\b/.test(command)) score += 1;
  return score;
}

export function profileMatchesPath(profile: TestProfile, path: string): boolean {
  const lowerPath = path.toLowerCase();
  const command = profile.command.toLowerCase();
  if (/\.(rs|toml)$/.test(lowerPath) || lowerPath.includes("cargo.toml")) return command.includes("cargo");
  if (/\.(py)$/.test(lowerPath) || lowerPath.includes("pyproject.toml") || lowerPath.includes("requirements.txt")) return command.includes("pytest") || command.includes("python");
  if (/\.(go)$/.test(lowerPath) || lowerPath.endsWith("go.mod")) return command.includes("go test") || command.includes("go ");
  if (/\.(ts|tsx|js|jsx|css|html|json)$/.test(lowerPath) || lowerPath.includes("package.json")) {
    return /npm|pnpm|yarn|bun|vitest|jest|tsc|eslint|biome/.test(command);
  }
  if (/\.(sql|prisma)$/.test(lowerPath)) return /test|check|prisma|sql/.test(command);
  return /test|check/.test(command);
}
