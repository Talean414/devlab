import { invoke, isTauri } from "@tauri-apps/api/core";

export type NativeCapability =
  | "native-runtime"
  | "filesystem"
  | "pty"
  | "process"
  | "git"
  | "docker"
  | "database"
  | "native-http"
  | "secure-storage"
  | "local-ai"
  | "agent-tools"
  | "test-runner"
  | "agent-audit"
  | "ci"
  | "deploy"
  | "toolchain";

export interface RuntimeInfo {
  runtime: "tauri" | "web";
  os: string;
  arch: string;
  appVersion: string;
  debug: boolean;
  capabilities: NativeCapability[];
}

export const WEB_RUNTIME: RuntimeInfo = {
  runtime: "web",
  os: "browser",
  arch: "unknown",
  appVersion: "1.37.0",
  debug: import.meta.env.DEV,
  capabilities: [],
};

/**
 * Ask the trusted backend for its identity. Checking isTauri first keeps the
 * normal Vite build useful for UI development without pretending native tools
 * are available.
 */
export async function detectRuntime(): Promise<RuntimeInfo> {
  if (!isTauri()) return WEB_RUNTIME;
  try {
    return await invoke<RuntimeInfo>("get_runtime_info");
  } catch (error) {
    console.error("[DevLab] Native runtime handshake failed", error);
    return WEB_RUNTIME;
  }
}

export function hasNativeCapability(runtime: RuntimeInfo, capability: NativeCapability): boolean {
  return runtime.runtime === "tauri" && runtime.capabilities.includes(capability);
}
