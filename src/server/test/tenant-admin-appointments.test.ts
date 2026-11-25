import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { Database, type Params } from "../src/db.js";
import { Repository } from "../src/repository.js";
import type { User } from "../src/domain.js";

it("lets current tenant admins promote only registered own-tenant users without changing report permissions", async context => {
  const tenantId = "11111111-1111-4111-8111-111111111111", targetId = "22222222-2222-4222-8222-222222222222";
  const actor: User = { Id: "actor", TenantId: tenantId, ObjectId: "actor", DirectoryId: "directory",
    DisplayName: "Admin", IsPlatformAdmin: false, IsTenantAdmin: true, DefaultPermissions: 0 };
  let currentAdmin = true, targetExists = true, updates = 0;
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: actor.ObjectId, directoryId: actor.DirectoryId, name: actor.DisplayName, username: "admin@example.invalid" };
  });
  context.mock.method(Repository.prototype, "user", async () => actor);
  context.mock.method(Repository.prototype, "audit", async () => []);
  context.mock.method(Database.prototype, "transaction", async work => work({ query: async (text: string, params?: Params) => {
    if (text.includes("ProvisioningOperations")) return [];
    if (text.startsWith("SELECT") && !text.includes("TenantId=@tenantId")) return [{ ...actor, IsTenantAdmin: currentAdmin }];
    if (text.startsWith("SELECT")) return targetExists ? [{ ...actor, Id: targetId }] : [];
    assert.match(text, /^UPDATE app.Users SET IsTenantAdmin=1/);
    assert.ok(!text.includes("DefaultPermissions") && !text.includes("IsPlatformAdmin"));
    assert.equal(params?.tenantId, tenantId); assert.equal(params?.id, targetId);
    updates++; return [];
  } } as never));
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${origin}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const post = (body: unknown, id = tenantId, csrf = session.csrf) => fetch(`${origin}/api/tenants/${id}/admins`,
      { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ userId: targetId })).status, 200);
    assert.equal((await post({ userId: targetId, isPlatformAdmin: true })).status, 400);
    assert.equal((await post({ userId: targetId }, targetId)).status, 403);
    assert.equal((await post({ userId: targetId }, tenantId, "")).status, 403);
    targetExists = false; assert.equal((await post({ userId: targetId })).status, 404);
    targetExists = true; currentAdmin = false; assert.equal((await post({ userId: targetId })).status, 403);
    actor.IsTenantAdmin = false; actor.IsPlatformAdmin = true;
    assert.equal((await post({ userId: targetId })).status, 403);
    assert.equal(updates, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
