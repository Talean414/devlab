import type { VFile } from "../types";

/**
 * Renderer-side reviewed-draft path policy.
 *
 * Every generator (Project Builder, Architecture Canvas, migrations, reverse
 * engineering, self-healing repairs, AI Agent extraction) already funnels its
 * in-memory drafts through one staging gate before Editor review. This module
 * lets that gate evaluate each draft path against a user-editable allow/deny
 * pattern policy plus a fixed secret-safe deny list, so a generated draft aimed
 * at `.env`, a private key or a credential file is refused before it can even be
 * staged, let alone applied.
 *
 * The policy only inspects paths. It never reads file contents, never writes,
 * and never relaxes the native Rust validation (traversal, absolute paths, byte
 * and file-count bounds) that still runs afterwards.
 */

export const DRAFT_POLICY_STORAGE_KEY = "devlab.draftPolicy.v1";
export const MAX_POLICY_PATTERNS = 64;
export const MAX_POLICY_PATTERN_CHARS = 200;

/** Always enforced, cannot be removed by settings; user patterns can only add to it. */
export const BUILTIN_SECRET_DENY_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "**/*.pem",
  "*.key",
  "**/*.key",
  "*.p12",
  "**/*.p12",
  "*.pfx",
  "**/*.pfx",
  "*.keystore",
  "**/*.keystore",
  "id_rsa*",
  "**/id_rsa*",
  "id_ed25519*",
  "**/id_ed25519*",
  ".npmrc",
  "**/.npmrc",
  ".netrc",
  "**/.netrc",
  ".git-credentials",
  "**/.git-credentials",
  ".git/**",
  "**/.git/**",
  ".ssh/**",
  "**/.ssh/**",
  ".aws/credentials",
  "**/.aws/credentials",
  "credentials.json",
  "**/credentials.json",
  "service-account*.json",
  "**/service-account*.json",
  "secrets.*",
  "**/secrets.*",
];

/** Allowed exceptions to the secret deny list: example/template files are useful to generate. */
export const BUILTIN_SECRET_ALLOW_EXCEPTIONS: readonly string[] = [
  ".env.example",
  "**/.env.example",
  ".env.sample",
  "**/.env.sample",
  ".env.template",
  "**/.env.template",
];

export interface DraftPathPolicy {
  /** When non-empty, a draft path must match at least one allow pattern. */
  allow: string[];
  /** A draft path matching any deny pattern is refused (in addition to the built-in secret list). */
  deny: string[];
  /** Whether the built-in secret deny list is enforced. It is always on; the flag exists only so the UI can show it. */
  builtinSecretDeny: true;
}

export const DEFAULT_DRAFT_POLICY: DraftPathPolicy = {
  allow: [],
  deny: [],
  builtinSecretDeny: true,
};

export type DraftPolicyVerdictKind = "allowed" | "denied-secret" | "denied-user" | "not-allowlisted";

export interface DraftPolicyVerdict {
  path: string;
  kind: DraftPolicyVerdictKind;
  matchedPattern: string | null;
  reason: string;
}

export interface DraftPolicyEvaluation {
  allowed: VFile[];
  refused: DraftPolicyVerdict[];
  verdicts: DraftPolicyVerdict[];
  summary: string;
}

export function loadDraftPolicy(): DraftPathPolicy {
  try {
    const raw = localStorage.getItem(DRAFT_POLICY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DRAFT_POLICY, allow: [], deny: [] };
    const parsed = JSON.parse(raw) as Partial<Record<"allow" | "deny", unknown>>;
    return {
      allow: sanitizePatterns(parsed.allow),
      deny: sanitizePatterns(parsed.deny),
      builtinSecretDeny: true,
    };
  } catch {
    return { ...DEFAULT_DRAFT_POLICY, allow: [], deny: [] };
  }
}

export function saveDraftPolicy(policy: Pick<DraftPathPolicy, "allow" | "deny">) {
  const next = { allow: sanitizePatterns(policy.allow), deny: sanitizePatterns(policy.deny) };
  localStorage.setItem(DRAFT_POLICY_STORAGE_KEY, JSON.stringify(next));
  return { ...next, builtinSecretDeny: true as const };
}

export function sanitizePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = normalizePattern(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_POLICY_PATTERNS) break;
  }
  return out;
}

export function parsePatternList(text: string): string[] {
  return sanitizePatterns(text.split(/\r?\n|,/));
}

export function normalizePattern(pattern: string): string {
  return pattern
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .slice(0, MAX_POLICY_PATTERN_CHARS);
}

export function normalizeDraftPathForPolicy(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

/**
 * Minimal glob matcher: `**` spans path segments, `*` matches within a
 * segment, `?` matches one character. Matching is case-insensitive because
 * secret files are frequently cased inconsistently across platforms.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const followedBySlash = pattern[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, "i");
}

export function matchesAnyPattern(path: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (!pattern) continue;
    try {
      if (globToRegExp(pattern).test(path)) return pattern;
    } catch {
      // Ignore malformed user patterns rather than failing open or closed on them.
    }
  }
  return null;
}

export function evaluateDraftPath(rawPath: string, policy: DraftPathPolicy): DraftPolicyVerdict {
  const path = normalizeDraftPathForPolicy(rawPath);
  const exception = matchesAnyPattern(path, BUILTIN_SECRET_ALLOW_EXCEPTIONS);
  if (!exception) {
    const secret = matchesAnyPattern(path, BUILTIN_SECRET_DENY_PATTERNS);
    if (secret) {
      return {
        path,
        kind: "denied-secret",
        matchedPattern: secret,
        reason: `Refused by the built-in secret-safe deny list (${secret}). DevLab does not stage generated credentials, keys or environment files.`,
      };
    }
  }
  const denied = matchesAnyPattern(path, policy.deny);
  if (denied) {
    return {
      path,
      kind: "denied-user",
      matchedPattern: denied,
      reason: `Refused by your draft policy deny pattern (${denied}).`,
    };
  }
  if (policy.allow.length > 0) {
    const allowed = matchesAnyPattern(path, policy.allow);
    if (!allowed) {
      return {
        path,
        kind: "not-allowlisted",
        matchedPattern: null,
        reason: "Refused because your draft policy allow list is non-empty and no allow pattern matches this path.",
      };
    }
    return { path, kind: "allowed", matchedPattern: allowed, reason: `Allowed by policy pattern ${allowed}.` };
  }
  return { path, kind: "allowed", matchedPattern: null, reason: "Allowed; no deny pattern matched and the allow list is empty." };
}

export function evaluateDrafts(files: VFile[], policy: DraftPathPolicy): DraftPolicyEvaluation {
  const verdicts = files.map((file) => evaluateDraftPath(file.path, policy));
  const allowed = files.filter((_, index) => verdicts[index].kind === "allowed");
  const refused = verdicts.filter((verdict) => verdict.kind !== "allowed");
  const secretCount = refused.filter((verdict) => verdict.kind === "denied-secret").length;
  const userCount = refused.filter((verdict) => verdict.kind === "denied-user").length;
  const allowlistCount = refused.filter((verdict) => verdict.kind === "not-allowlisted").length;
  const summary = refused.length === 0
    ? `${allowed.length} draft path${allowed.length === 1 ? "" : "s"} allowed by policy`
    : `${allowed.length} allowed · ${refused.length} refused (${secretCount} secret-safe, ${userCount} deny pattern, ${allowlistCount} not allow-listed)`;
  return { allowed, refused, verdicts, summary };
}

export function describeDraftPolicy(policy: DraftPathPolicy): string {
  const parts = [`built-in secret deny list (${BUILTIN_SECRET_DENY_PATTERNS.length} patterns, always on)`];
  parts.push(policy.deny.length > 0 ? `${policy.deny.length} user deny pattern${policy.deny.length === 1 ? "" : "s"}` : "no user deny patterns");
  parts.push(policy.allow.length > 0 ? `${policy.allow.length} allow pattern${policy.allow.length === 1 ? "" : "s"} (allow-list mode)` : "allow list empty (all non-denied paths permitted)");
  return parts.join(" · ");
}
