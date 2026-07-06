import { Database } from "bun:sqlite";
import { dirname } from "path";
import { mkdirSync, existsSync } from "fs";

let db: Database | null = null;
let databasePath = "game.db"; // Default, can be overridden by configuration

export function setDatabasePath(path: string) {
  if (db) {
    throw new Error("Cannot set database path after database has been initialized.");
  }
  databasePath = path;
}

export function getDB(): Database {
  if (!db) {
    const dir = dirname(databasePath);
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    db = new Database(databasePath);
    // Enable WAL mode for high performance concurrent reads and writes
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA foreign_keys = ON;");
    // Prevent database locked exceptions (SQLITE_BUSY) under concurrent writes
    db.run("PRAGMA busy_timeout = 5000;");
  }
  return db;
}

export function getServerState(key: string): string | null {
  try {
    const database = getDB();
    const row = database.query("SELECT value FROM server_state WHERE key = $key").get({ $key: key }) as { value: string } | null;
    return row ? row.value : null;
  } catch (e) {
    return null;
  }
}

export function setServerState(key: string, value: string) {
  try {
    const database = getDB();
    database.query("INSERT OR REPLACE INTO server_state (key, value) VALUES ($key, $value)").run({
      $key: key,
      $value: value
    });
  } catch (e) {
    console.error(`Failed to update server state for key: ${key}`, e);
  }
}
