import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { Repository } from "../src/repository.js";
import { TenantProvisioner } from "../src/provisioning.js";
import type { User } from "../src/domain.js";

it("authorizes tenant sample status/add/retry, rejects target overrides and never requests a delegated operator token", async context => {
  const tenantId = randomUUID(), otherTenant = randomUUID(), operationId = randomUUID();
  const user: User = { Id: randomUUID(), TenantId: null, DirectoryId: randomUUID(), ObjectId: randomUUID(),
    DisplayName: "Admin", IsPlatformAdmin: true, IsTenantAdmin: false, DefaultPermissions: 0 };
  const operation = { id: operationId, tenantId, status: "Running", steps: [], error: null, canRetry: false, recoveryRequired: false };
  const calls: string[] = [];
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "admin@example.test" };
  });
  context.mock.method(AuthService.prototype, "operatorToken", async () => { throw new Error("Sample addition must use only the tenant principal."); });
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(TenantProvisioner.prototype, "sampleStatus", async actor => {
    assert.equal(actor, user); calls.push("status"); return { operation };
  });
  context.mock.method(TenantProvisioner.prototype, "addSample", async (actor, id) => {
    assert.equal(actor, user); assert.equal(id, operationId); calls.push("add"); return operation;
  });
  context.mock.method(TenantProvisioner.prototype, "retrySample", async (id, actor) => {
    assert.equal(id, operationId); assert.equal(actor, user); calls.push("retry"); return operation;
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${origin}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
    const request = (tenant: string, method = "GET", suffix = "", body: unknown = {}) =>
      fetch(`${origin}/api/tenants/${tenant}/sample${suffix}`,
        { method, headers, body: method === "GET" ? undefined : JSON.stringify(body) });
    const mutations = [["GET", "", {}], ["POST", "", { requestId: operationId }],
      ["POST", `/${operationId}/retry`, {}]] as const;
    for (const [method, suffix, body] of mutations)
      assert.equal((await request(tenantId, method, suffix, body)).status, 403);
    user.TenantId = tenantId;
    assert.equal((await request(tenantId)).status, 403);
    user.IsPlatformAdmin = false; user.IsTenantAdmin = true;
    for (const [method, suffix, body] of mutations)
      assert.equal((await request(otherTenant, method, suffix, body)).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request(tenantId, "POST", "", {})).status, 400);
    assert.equal((await request(tenantId, "POST", "", { requestId: operationId, workspaceId: otherTenant, samplePath: "../private.pbix" })).status, 400);
    assert.equal((await request(tenantId, "POST", `/${operationId}/retry`, { tenantId: otherTenant })).status, 400);
    for (const [method, suffix, body] of mutations)
      assert.equal((await request(tenantId, method, suffix, body)).status, method === "GET" ? 200 : 202);
    assert.deepEqual(calls, ["status", "add", "retry"]);
    assert.equal((await fetch(`${origin}/api/tenants/${tenantId}/sample`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: operationId }),
    })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
