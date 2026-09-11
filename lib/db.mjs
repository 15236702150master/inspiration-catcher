import Database from "better-sqlite3";
import { join } from "node:path";
import { applySchema, migrateLegacyData } from "./migrations.mjs";

export function openDatabase({ databasePath, dataDirectory, migrateLegacy = true } = {}) {
  const resolved = databasePath || join(dataDirectory || "data", "inspiration.sqlite3");
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applySchema(db);
  if (migrateLegacy && dataDirectory) migrateLegacyData(db, { dataDirectory });
  return db;
}
