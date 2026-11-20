import { it } from "node:test";
import assert from "node:assert/strict";
import type { Database, Executor } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { AppError } from "../src/errors.js";

it("does not reassign an identity from another tenant when appointing a tenant administrator", async () => {
  let writes = 0;
  const executor = { query: async (text: string) => {
    if (text.includes("FROM app.Tenants")) return [{ Id: "tenant-a" }];
    if (text.includes("FROM app.Users")) return [{ Id: "existing", TenantId: "tenant-b" }];
    writes++;
    return [];
  } } as Executor;
  const repository = new Repository({ transaction: async work => work(executor) } as Database);
  await assert.rejects(repository.assignTenantAdmin("tenant-a", "directory", "object", "Existing user"),
    error => error instanceof AppError && error.status === 409);
  assert.equal(writes, 0);
});
