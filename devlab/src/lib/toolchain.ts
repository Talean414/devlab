import { invoke } from "@tauri-apps/api/core";

export interface ToolchainTool {
  id: string;
  label: string;
  category: string;
  command: string;
  args: string[];
  available: boolean;
  version: string | null;
  detail: string;
  errorCode: string | null;
}

export interface ToolchainSnapshot {
  checkedAtMs: number;
  timeoutMs: number;
  maxOutputBytes: number;
  tools: ToolchainTool[];
}

export function toolchainSnapshot(): Promise<ToolchainSnapshot> {
  return invoke<ToolchainSnapshot>("toolchain_snapshot");
}
