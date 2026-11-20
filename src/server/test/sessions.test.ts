import { it } from "node:test";
import assert from "node:assert/strict";
import type { SessionData } from "express-session";
import { EncryptedSqlSessionStore } from "../src/auth.js";
import type { Database } from "../src/db.js";

it("keeps delegated token caches encrypted in SQL and round-trips the session", async () => {
  let encrypted = "";
  const db = { query: async (sql: string, values?: Record<string, unknown>) => {
    if (sql.startsWith("MERGE")) { encrypted = String(values!.data); return []; }
    return [{ Data: encrypted }];
  } } as unknown as Database;
  db.read = db.query.bind(db);
  const store = new EncryptedSqlSessionStore(db, async () => "unit-test-only-not-a-real-credential");
  const original = { cookie: { expires: new Date(Date.now() + 60000) }, msalCache: "unit-test-cache", csrf: "unit-test-csrf" } as SessionData;
  await new Promise<void>((resolve, reject) => store.set("session", original, error => error ? reject(error) : resolve()));
  assert.ok(encrypted);
  assert.ok(!encrypted.includes(original.msalCache!));
  assert.ok(!encrypted.includes(original.csrf!));
  const result = await new Promise<SessionData | null | undefined>((resolve, reject) => store.get("session", (error, value) => error ? reject(error) : resolve(value)));
  assert.equal(result!.msalCache, original.msalCache);
  assert.equal(result!.csrf, original.csrf);
});
