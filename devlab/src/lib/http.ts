import { invoke } from "@tauri-apps/api/core";

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string;
  timeoutSecs: number;
}

export interface HttpResponse {
  url: string;
  status: number;
  statusText: string;
  headers: HttpHeader[];
  body: string;
  bodyKind: "text" | "binary";
  bodyTruncated: boolean;
  bytesReceived: number;
  requestBodyBytes: number;
  elapsedMs: number;
}

export function parseHeaderLines(value: string): HttpHeader[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const split = line.indexOf(":");
      if (split <= 0) {
        throw new Error(`Header line ${index + 1} must use Name: value syntax.`);
      }
      const name = line.slice(0, split).trim();
      const headerValue = line.slice(split + 1).trim();
      if (!name) throw new Error(`Header line ${index + 1} is missing a name.`);
      return { name, value: headerValue };
    });
}

export async function runHttpRequest(request: HttpRequest): Promise<HttpResponse> {
  return invoke<HttpResponse>("http_request", { request });
}
