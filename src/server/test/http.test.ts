import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { FabricService } from "../src/fabric.js";
import { Repository } from "../src/repository.js";
import { Database } from "../src/db.js";
import { AzureServices } from "../src/azure.js";
import { AppError } from "../src/errors.js";
import type { Tenant, User } from "../src/domain.js";

it("serves local setup without credentials and denies unauthenticated privileged routes", async () => {
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "", SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "" });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    const response = await fetch(`${base}/api/session`);
    const session = await response.json() as { configured: boolean; identity: unknown; csrf: string };
    assert.equal(session.configured, false);
    assert.equal(session.identity, null);
    assert.ok(session.csrf.length >= 32);
    assert.equal((await fetch(`${base}/api/admin/tenants`)).status, 401);
    assert.equal((await fetch(`${base}/api/bootstrap`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/tenants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

it("separates platform administration from tenant data, membership, permissions and administrator appointment", async context => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const otherTenantId = "22222222-2222-4222-8222-222222222222";
  const memberId = "33333333-3333-4333-8333-333333333333";
  const objectId = "44444444-4444-4444-8444-444444444444";
  const user: User = { Id: "operator", TenantId: null, DirectoryId: "directory", ObjectId: "operator",
    DisplayName: "Operator", IsPlatformAdmin: true, IsTenantAdmin: false, DefaultPermissions: 0 };
  const appointments: unknown[][] = [];
  const lookups: string[] = [];
  const writes: unknown[] = [];
  context.mock.method(AzureServices.prototype, "resolveUserPrincipalName", async upn => {
    lookups.push(upn);
    if (upn === "missing@contoso.com") throw new AppError(404, "DirectoryUserNotFound", "No exact UPN match.");
    return { objectId: "55555555-5555-4555-8555-555555555555", displayName: "Directory administrator" };
  });
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "operator@example.test" };
  });
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Repository.prototype, "tenants", async () => [{ Id: tenantId }, { Id: otherTenantId }]);
  context.mock.method(Repository.prototype, "tenant", async id => ({ Id: id, Name: "Tenant" }));
  context.mock.method(Repository.prototype, "users", async () => [
    { Id: memberId, ObjectId: objectId, DisplayName: "Admin", IsTenantAdmin: true, DefaultPermissions: 127 },
    { Id: "viewer", ObjectId: "viewer", DisplayName: "Viewer", IsTenantAdmin: false },
  ]);
  context.mock.method(Repository.prototype, "content", async () => []);
  context.mock.method(Repository.prototype, "security", async () => ({ nodes: [], grants: [] }));
  context.mock.method(Repository.prototype, "audit", async () => undefined);
  context.mock.method(Repository.prototype, "assignTenantAdmin", async (...args) => { appointments.push(args); });
  context.mock.method(Database.prototype, "query", async (text, params) => {
    if (!text.includes("SELECT Id FROM app.ProvisioningOperations")) writes.push(params);
    return [];
  });
  context.mock.method(FabricService.prototype, "sync", async () => ({ reports: 0, models: 0 }));
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
    const request = (route: string, method = "GET", body?: unknown) => fetch(`${base}${route}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await request("/api/admin/tenants")).status, 200);
    for (const [route, method, body] of [
      ["/api/me/content", "GET"],
      ["/api/embed/report", "POST", { contentId: memberId }],
      ["/api/embed/create", "POST", { modelId: memberId }],
      [`/api/tenants/${tenantId}/manage`, "GET"],
      [`/api/tenants/${otherTenantId}/manage`, "GET"],
      [`/api/tenants/${tenantId}/sync`, "POST", {}],
      [`/api/tenants/${tenantId}/users`, "POST", {}],
      [`/api/tenants/${tenantId}/folders`, "POST", {}],
      [`/api/tenants/${tenantId}/content/${memberId}`, "PATCH", {}],
      [`/api/tenants/${tenantId}/nodes/${memberId}`, "PATCH", {}],
      [`/api/tenants/${tenantId}/grants`, "PUT", {}],
    ] as const) assert.equal((await request(route, method, body)).status, 403, `${method} ${route}`);
    const admins = `/api/admin/tenants/${tenantId}/admins`;
    assert.deepEqual(await (await request(admins)).json(), [{ Id: memberId, ObjectId: objectId, DisplayName: "Admin" }]);
    assert.equal((await request(admins, "POST", { objectId, displayName: "Admin" })).status, 200);
    assert.deepEqual(appointments, [[tenantId, "", objectId, "Admin"]]);
    assert.equal((await request(admins, "POST", { userPrincipalName: "admin@contoso.com" })).status, 200);
    assert.deepEqual(appointments[1], [tenantId, "", "55555555-5555-4555-8555-555555555555", "Directory administrator"]);
    assert.equal((await request(admins, "POST", { userPrincipalName: "admin@contoso.com", objectId, displayName: "Override" })).status, 400);
    assert.equal((await request(admins, "POST", { userPrincipalName: "not-a-upn" })).status, 400);
    assert.equal((await request(admins, "POST", { userPrincipalName: "missing@contoso.com" })).status, 404);
    assert.equal(appointments.length, 2);
    assert.equal((await request(admins, "POST", { objectId, displayName: "Admin", permissions: 127 })).status, 400);
    assert.equal((await request(`${admins}/${memberId}`, "DELETE")).status, 200);
    assert.deepEqual(writes, [{ userId: memberId, id: tenantId }]);
    user.TenantId = tenantId;
    assert.equal((await request(`/api/tenants/${tenantId}/manage`)).status, 403);
    user.IsTenantAdmin = true;
    assert.equal((await request(`/api/tenants/${tenantId}/manage`)).status, 200);
    assert.equal((await request(`/api/tenants/${otherTenantId}/manage`)).status, 403);
    assert.equal((await request(`/api/tenants/${tenantId}/users`, "POST",
      { objectId, displayName: "Escalation", isTenantAdmin: true })).status, 400);
    assert.equal((await request(`/api/tenants/${tenantId}/users/${memberId}`, "PATCH",
      { permissions: 1, isTenantAdmin: true })).status, 400);
    assert.equal((await request(`/api/tenants/${tenantId}/users/${memberId}`, "PATCH", { permissions: 1 })).status, 200);
    user.IsPlatformAdmin = false;
    assert.equal((await request(`/api/tenants/${tenantId}/sync`, "POST", {})).status, 200);
    assert.equal((await request("/api/admin/tenants")).status, 403);
    assert.equal((await request(admins, "POST", { objectId, displayName: "Admin" })).status, 403);
    assert.equal((await request(admins, "POST", { userPrincipalName: "admin@contoso.com" })).status, 403);
    assert.deepEqual(lookups, ["admin@contoso.com", "missing@contoso.com"]);
    assert.equal(appointments.length, 2);
    user.IsTenantAdmin = false;
    assert.equal((await request(`/api/tenants/${tenantId}/manage`)).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

it("assigns one shared capacity to separate tenant workspaces without reserving it or bypassing admin guards", async context => {
  const capacityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const managementCapacityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const tenants: Tenant[] = [
    { Id: "11111111-1111-4111-8111-111111111111", Name: "Tenant A",
      WorkspaceId: "11111111-2222-4333-8444-555555555555" },
    { Id: "22222222-2222-4222-8222-222222222222", Name: "Tenant B",
      WorkspaceId: "22222222-3333-4444-8555-666666666666" },
  ].map(tenant => ({ ...tenant, Status: "NeedsConfiguration", EmbeddingClientId: null, EmbeddingObjectId: null,
    EmbeddingAppObjectId: null, SecretName: null, LastIssue: null, ReadinessJson: null, LastCheckedAt: null }));
  const user: User = { Id: "operator", TenantId: tenants[0]!.Id, DirectoryId: "directory", ObjectId: "operator",
    DisplayName: "Operator", IsPlatformAdmin: true, IsTenantAdmin: true, DefaultPermissions: 0 };
  const assignments: { workspace: string; body: unknown }[] = [];
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "operator@example.test" };
  });

  context.mock.method(AuthService.prototype, "operatorToken", async () => "test-only");
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Repository.prototype, "tenant", async id => {
    const tenant = tenants.find(t => t.Id === id);
    assert.ok(tenant);
    return tenant;
  });
  context.mock.method(Repository.prototype, "audit", async () => undefined);
  context.mock.method(Database.prototype, "query", async () => []);
  context.mock.method(FabricService.prototype, "operator", async (_token, suffix, method = "GET", body) => {
    if (suffix === "/capacities") return { value: [{ id: capacityId }, { id: managementCapacityId }] };
    assert.equal(method, "POST");
    assignments.push({ workspace: suffix, body });
    return {};
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "", ManagementCapacityId: managementCapacityId });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
    const assign = (tenantId: string, id = capacityId) => fetch(`${base}/api/admin/tenants/${tenantId}/capacity`,
      { method: "POST", headers, body: JSON.stringify({ capacityId: id }) });
    for (const tenant of tenants) {
      assert.equal((await assign(tenant.Id)).status, 202);
      const available = await (await fetch(`${base}/api/admin/capacities/assignable`, { headers })).json();
      assert.deepEqual(available, { value: [{ id: capacityId }] });
    }
    assert.deepEqual(assignments, tenants.map(tenant => ({
      workspace: `/groups/${tenant.WorkspaceId}/AssignToCapacity`, body: { capacityId },
    })));
    assert.equal((await assign(tenants[0]!.Id, managementCapacityId)).status, 409);
    assert.equal((await assign(tenants[0]!.Id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).status, 403);
    tenants[1]!.WorkspaceId = null;
    assert.equal((await assign(tenants[1]!.Id)).status, 409);
    user.IsPlatformAdmin = false;
    assert.equal((await assign(tenants[0]!.Id)).status, 403);
    assert.equal(assignments.length, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
