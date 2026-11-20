import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { Repository } from "../src/repository.js";
import { Database } from "../src/db.js";
import { TenantProvisioner } from "../src/provisioning.js";
import type { User } from "../src/domain.js";

it("authorizes guided setup, settings, progress and retries on the backend and validates the complete setup request", async context => {
  const tenantId = "11111111-1111-4111-8111-111111111111", operationId = "22222222-2222-4222-8222-222222222222";
  const user: User = { Id: "operator", TenantId: null, DirectoryId: "directory", ObjectId: "operator",
    DisplayName: "Operator", IsPlatformAdmin: true, IsTenantAdmin: false, DefaultPermissions: 0 };
  const operation = { id: operationId, tenantId, status: "Running", steps: [], error: null, canRetry: false, recoveryRequired: false };
  const starts: unknown[][] = [];
  let settingsReads = 0, progressReads = 0, retries = 0;
  let activeSetup = false;
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "operator@contoso.com" };
  });
  context.mock.method(AuthService.prototype, "operatorToken", async () => "backend-only-token");
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Database.prototype, "query", async () => activeSetup ? [{ Id: operationId }] : []);
  context.mock.method(TenantProvisioner.prototype, "start", async (...args) => { starts.push(args); return operation; });
  context.mock.method(TenantProvisioner.prototype, "settings", async () => { settingsReads++; return { tenant: { Id: tenantId } }; });
  context.mock.method(TenantProvisioner.prototype, "operation", async () => { progressReads++; return operation; });
  context.mock.method(TenantProvisioner.prototype, "view", value => value);
  context.mock.method(TenantProvisioner.prototype, "retry", async () => { retries++; return operation; });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
    const request = (route: string, method = "GET", body?: unknown) => fetch(`${base}${route}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const input = { requestId: operationId, name: "Customer", administratorUpn: "admin@contoso.com", includeSample: true,
      capacity: { mode: "existing", id: tenantId } };
    assert.equal((await request("/api/admin/tenants", "POST", { name: "Old incomplete flow" })).status, 400);
    assert.equal((await request("/api/admin/tenants", "POST", { ...input, capacity: { mode: "new", sku: "F2" } })).status, 400);
    assert.equal((await request("/api/admin/tenants", "POST", { ...input, administratorUpn: "invalid" })).status, 400);
    assert.equal((await request("/api/admin/tenants", "POST", { ...input, includeSample: "yes" })).status, 400);
    assert.equal((await request("/api/admin/tenants", "POST", { ...input, samplePath: "../private.pbix", workspaceId: tenantId })).status, 400);
    const response = await request("/api/admin/tenants", "POST", input);
    assert.equal(response.status, 202); assert.ok(!JSON.stringify(await response.json()).includes("backend-only-token"));
    assert.equal(starts[0]![2], "operator@contoso.com"); assert.equal(starts[0]![3], "backend-only-token");
    assert.equal(starts[0]![4], undefined);
    assert.equal((starts[0]![0] as { includeSample: boolean }).includeSample, true);
    assert.equal((await request(`/api/admin/tenants/${tenantId}/setup`, "POST", input)).status, 202);
    assert.equal(starts[1]![4], tenantId);
    activeSetup = true;
    for (const suffix of ["identity", "workspace", "access", "capacity", "readiness", "admins"])
      assert.equal((await request(`/api/admin/tenants/${tenantId}/${suffix}`, "POST", {})).status, 409);
    activeSetup = false;
    const routes = [[`/api/admin/tenants/${tenantId}/settings`, "GET"], [`/api/admin/operations/${operationId}`, "GET"],
      [`/api/admin/operations/${operationId}/retry`, "POST"]] as const;
    for (const [route, method] of routes) assert.ok((await request(route, method)).ok);
    user.IsPlatformAdmin = false; user.TenantId = tenantId; user.IsTenantAdmin = true;
    for (const [route, method] of routes) assert.equal((await request(route, method)).status, 403);
    assert.equal((await request("/api/admin/tenants", "POST", input)).status, 403);
    assert.equal((await request(`/api/admin/tenants/${tenantId}/setup`, "POST", input)).status, 403);
    assert.equal(starts.length, 2); assert.equal(settingsReads, 1); assert.equal(progressReads, 1); assert.equal(retries, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
