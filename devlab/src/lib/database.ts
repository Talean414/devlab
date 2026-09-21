import { invoke } from "@tauri-apps/api/core";
import type { NativeCommandError } from "./workspace";

export type PostgresTlsMode = "verify-full" | "disable";

export interface PostgresConnectRequest {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsMode: PostgresTlsMode;
  allowWrites: boolean;
  storePassword: boolean;
}

export interface PostgresConnectionInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  tlsMode: PostgresTlsMode;
  allowWrites: boolean;
  serverVersion: string;
  credentialStored: boolean;
}

export interface DatabaseConnectionInfo {
  id: string;
  name: string;
  engine: "SQLite";
  path: string;
  allowWrites: boolean;
  sqliteVersion: string;
  fileSize: number | null;
}

export interface DatabaseColumn {
  position: number;
  name: string;
  dataType: string;
  notNull: boolean;
  defaultValue: string | null;
  defaultValueTruncated: boolean;
  primaryKey: boolean;
  hidden: boolean;
}

export interface DatabaseObject {
  name: string;
  kind: "table" | "view";
  columns: DatabaseColumn[];
}

export interface DatabaseSchema {
  connection: DatabaseConnectionInfo;
  objects: DatabaseObject[];
}

export type DatabaseCellKind = "null" | "integer" | "real" | "text" | "blob";

export interface DatabaseCell {
  kind: DatabaseCellKind;
  value: string;
  truncated: boolean;
}

export interface DatabaseQueryResult {
  columns: string[];
  rows: DatabaseCell[][];
  rowCount: number;
  affectedRows: number;
  readOnly: boolean;
  truncated: boolean;
  elapsedMs: number;
}

export class DatabaseCommandError extends Error {
  readonly code: string;

  constructor(error: NativeCommandError) {
    super(error.message);
    this.name = "DatabaseCommandError";
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
      throw new DatabaseCommandError({ code: error.code, message: error.message });
    }
    throw new DatabaseCommandError({
      code: "native_command_failed",
      message: typeof error === "string" ? error : "The native database command failed.",
    });
  });
}

export function getDatabaseConnections(): Promise<DatabaseConnectionInfo[]> {
  return command("database_connections");
}

export function selectSqliteDatabase(
  allowWrites: boolean,
): Promise<DatabaseConnectionInfo | null> {
  return command("database_sqlite_select", { allowWrites });
}

export function getDatabaseSchema(id: string): Promise<DatabaseSchema> {
  return command("database_schema", { id });
}

export function runDatabaseQuery(
  id: string,
  sql: string,
  confirmedWrite = false,
): Promise<DatabaseQueryResult> {
  return command("database_query", { id, sql, confirmedWrite });
}

export function setDatabaseWriteAccess(
  id: string,
  allowWrites: boolean,
): Promise<DatabaseConnectionInfo> {
  return command("database_set_write_access", { id, allowWrites });
}

export function disconnectDatabase(id: string): Promise<void> {
  return command("database_disconnect", { id });
}

export function getPostgresConnections(): Promise<PostgresConnectionInfo[]> {
  return command("database_postgres_connections");
}

export function connectPostgres(
  request: PostgresConnectRequest,
): Promise<PostgresConnectionInfo> {
  return command("database_postgres_connect", { request });
}

export function disconnectPostgres(id: string): Promise<void> {
  return command("database_postgres_disconnect", { id });
}

export function forgetPostgresPassword(id: string): Promise<PostgresConnectionInfo> {
  return command("database_postgres_forget_password", { id });
}
