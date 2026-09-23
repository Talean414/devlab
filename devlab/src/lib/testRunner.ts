import { invoke } from "@tauri-apps/api/core";

export interface TestProfile {
  id: string;
  label: string;
  command: string;
  reason: string;
  /** "test" runs a suite; "check" is a non-mutating verification (typecheck, lint, static analysis). Older backends omit it. */
  kind?: "test" | "check";
}

export interface TestRunnerSnapshot {
  workspaceName: string;
  workspacePath: string;
  timeoutSecs: number;
  maxOutputBytes: number;
  profiles: TestProfile[];
  warnings: string[];
}

export interface TestRunResult {
  profile: TestProfile;
  status: "passed" | "failed" | "timeout";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

export function testRunnerSnapshot(): Promise<TestRunnerSnapshot> {
  return invoke<TestRunnerSnapshot>("test_runner_snapshot");
}

export function testRunnerRun(profileId: string): Promise<TestRunResult> {
  return invoke<TestRunResult>("test_runner_run", { profileId });
}
