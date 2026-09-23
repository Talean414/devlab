import { invoke } from "@tauri-apps/api/core";
import type { NativeCommandError } from "./workspace";

export interface DockerStateMessage {
  code: string;
  message: string;
}

export interface DockerStats {
  cpuPercent: string;
  memoryUsage: string;
  memoryPercent: string;
  networkIo: string;
  blockIo: string;
  pids: string;
}

export interface DockerContainer {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  running: boolean;
  stats: DockerStats | null;
}

export interface DockerImage {
  id: string;
  shortId: string;
  repository: string;
  tag: string;
  digest: string;
  size: string;
  createdSince: string;
}

export interface DockerSnapshot {
  cliInstalled: boolean;
  cliVersion: string | null;
  daemonConnected: boolean;
  daemonVersion: string | null;
  state: DockerStateMessage;
  containers: DockerContainer[];
  images: DockerImage[];
}

export interface DockerOperationResult {
  message: string;
  output: string;
  snapshot: DockerSnapshot;
}

export interface DockerLogs {
  containerId: string;
  containerName: string;
  content: string;
}

export type DockerPortProtocol = "tcp" | "udp";

export interface DockerPortMapping {
  hostPort: number;
  containerPort: number;
  protocol: DockerPortProtocol;
}

export interface DockerCreateRequest {
  name: string;
  image: string;
  ports: DockerPortMapping[];
}

export class DockerCommandError extends Error {
  readonly code: string;

  constructor(error: NativeCommandError) {
    super(error.message);
    this.name = "DockerCommandError";
    this.code = error.code;
  }
}

function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args).catch((error: unknown) => {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && "message" in error
      && typeof error.code === "string"
      && typeof error.message === "string"
    ) {
      throw new DockerCommandError({ code: error.code, message: error.message });
    }
    throw new DockerCommandError({
      code: "native_command_failed",
      message: typeof error === "string" ? error : "The native Docker command failed.",
    });
  });
}

export function getDockerSnapshot(): Promise<DockerSnapshot> {
  return command("docker_snapshot");
}

export function pullDockerImage(reference: string): Promise<DockerOperationResult> {
  return command("docker_pull", { reference });
}

export function createDockerContainer(request: DockerCreateRequest): Promise<DockerOperationResult> {
  return command("docker_create", { request });
}

export function startDockerContainer(id: string): Promise<DockerOperationResult> {
  return command("docker_start", { id });
}

export function stopDockerContainer(id: string): Promise<DockerOperationResult> {
  return command("docker_stop", { id });
}

export function restartDockerContainer(id: string): Promise<DockerOperationResult> {
  return command("docker_restart", { id });
}

export function removeDockerContainer(id: string): Promise<DockerOperationResult> {
  return command("docker_remove", { id });
}

export function getDockerLogs(id: string): Promise<DockerLogs> {
  return command("docker_logs", { id });
}
