import { resolve, join } from "node:path";
import { openDatabase } from "../lib/db.mjs";
import { migrateLegacyData } from "../lib/migrations.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dataDirectory = resolve(option("--data", process.env.DATA_DIRECTORY || "data"));
const dryRun = process.argv.includes("--dry-run");
const databasePath = dryRun ? ":memory:" : resolve(option("--db", process.env.DATABASE_PATH || join(dataDirectory, "inspiration.sqlite3")));
const db = openDatabase({ databasePath, dataDirectory, migrateLegacy: false });
try {
  const report = migrateLegacyData(db, { dataDirectory, dryRun });
  process.stdout.write(`${JSON.stringify({ databasePath, dataDirectory, ...report }, null, 2)}\n`);
} finally {
  db.close();
}
