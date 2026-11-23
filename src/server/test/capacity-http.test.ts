import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { CapacityManagement } from "../src/capacity-management.js";
import { CapacityPolicy } from "../src/capacity-policy.js";
import { config } from "../src/config.js";
import type { User } from "../src/domain.js";
import { Repository } from "../src/repository.js";
import { Database } from "../src/db.js";
import { FabricService } from "../src/fabric.js";

it("guards tenant repair endpoints with platform authority, CSRF, exact consent and the running-setup exclusion", async context => {
  const tenantId = randomUUID(), workspaceId = randomUUID(), principalId = randomUUID();
  const user = { Id: randomUUID(), ObjectId: randomUUID(), DirectoryId: randomUUID(), TenantId: tenantId,
    DisplayName: "Admin", IsPlatformAdmin: false, IsTenantAdmin: true } as User;
  let running = false;
  const calls: unknown[][] = [];
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "admin@example.test" };
  });
  context.mock.method(AuthService.prototype, "operatorToken", async () => "operator");
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Database.prototype, "query", async () => running ? [{ Id: randomUUID() }] : []);
  context.mock.method(CapacityManagement.prototype, "forTenant", async (...args) => { calls.push(["read", ...args]); return { capacity: null, issue: null }; });
  context.mock.method(CapacityManagement.prototype, "resumeTenant", async (...args) => { calls.push(["resume", ...args]); return { status: "accepted" }; });
  context.mock.method(FabricService.prototype, "repairWorkspaceAccess", async (...args) => { calls.push(["access", ...args]); return { status: "applied" }; });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin/tenants/${tenantId}`;
  try {
    assert.equal((await fetch(`${base}/capacity`)).status, 401);
    const login = await fetch(base.replace(`/api/admin/tenants/${tenantId}`, "/auth/callback"), { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(base.replace(`/api/admin/tenants/${tenantId}`, "/api/session"), { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf };
    const resume = { confirmName: "fixtureone", confirmBilling: true };
    const access = { confirmWorkspaceId: workspaceId, confirmPrincipalId: principalId, confirmAccess: true };
    const request = (suffix: string, body?: unknown, csrf = true) => fetch(`${base}/${suffix}`, {
      method: body === undefined ? "GET" : "POST", headers: csrf ? headers : { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const [suffix, body] of [["capacity", undefined], ["capacity/resume", resume], ["remediation/access", access]] as const)
      assert.equal((await request(suffix, body)).status, 403);
    assert.equal(calls.length, 0);
    user.IsPlatformAdmin = true;
    assert.equal((await request("capacity")).status, 200);
    for (const body of [{ confirmName: "fixtureone" }, { ...resume, confirmBilling: false }, { ...resume, resourceId: "other" }])
      assert.equal((await request("capacity/resume", body)).status, 400);
    for (const body of [{ ...access, confirmAccess: false }, { ...access, principalId: randomUUID() }, { ...access, confirmWorkspaceId: "bad" }])
      assert.equal((await request("remediation/access", body)).status, 400);
    for (const [suffix, body] of [["capacity/resume", resume], ["remediation/access", access]] as const) {
      assert.equal((await request(suffix, body, false)).status, 403);
      running = true; assert.equal((await request(suffix, body)).status, 409); running = false;
    }
    assert.equal(calls.length, 1);
    assert.equal((await request("capacity/resume", resume)).status, 202);
    assert.equal((await request("remediation/access", access)).status, 200);
    assert.deepEqual(calls[1], ["resume", tenantId, "operator", "fixtureone", user]);
    assert.deepEqual(calls[2], ["access", tenantId, "operator", workspaceId, principalId, user]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

it("restricts capacity inventory and bulk/individual actions to platform admins and enforces CSRF and strict confirmation", async context => {
  const user: User = { Id: randomUUID(), ObjectId: randomUUID(), DirectoryId: randomUUID(), TenantId: randomUUID(),
    DisplayName: "Tenant administrator", IsPlatformAdmin: false, IsTenantAdmin: true, DefaultPermissions: 127 };
  const calls: unknown[][] = [];
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "admin@example.test" };
  });

  context.mock.method(AuthService.prototype, "operatorToken", async () => "operator-token");
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Repository.prototype, "audit", async () => []);
  context.mock.method(CapacityManagement.prototype, "list", async () => { calls.push(["list"]); return { value: [] }; });
  context.mock.method(CapacityManagement.prototype, "inventory", async token => {
    calls.push(["inventory", token]); return { value: [], issues: [], excludedTenants: [] };
  });
  context.mock.method(CapacityManagement.prototype, "bulk", async (...args) => {
    calls.push(["bulk", ...args]); return { action: args[1], results: [] };
  });
  context.mock.method(CapacityManagement.prototype, "change", async (...args) => {
    calls.push(["change", ...args]); return { name: args[0], status: "accepted", message: "Request accepted." };
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/admin/capacities/tenants`)).status, 401);
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
    const request = (route: string, method = "GET", body?: unknown) =>
      fetch(`${base}/api/admin/capacities${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const bulk = { action: "suspend", confirmNames: ["fixtureone"] };
    assert.equal((await request("/tenants")).status, 403);
    assert.equal((await request("/bulk/action", "POST", bulk)).status, 403);
    assert.equal((await request("/fixtureone/action", "POST", { action: "resize", sku: "F4", confirmName: "fixtureone" })).status, 403);
    assert.equal(calls.length, 0);
    user.IsPlatformAdmin = true;
    assert.equal((await request("/tenants")).status, 200);
    for (const body of [{ action: "suspend" }, { ...bulk, resourceId: "/other/scope" },
      { ...bulk, action: "resize" }, { ...bulk, confirmNames: [] }])
      assert.equal((await request("/bulk/action", "POST", body)).status, 400);
    assert.equal((await request("/fixtureone/action", "POST", { action: "resize", confirmName: "fixtureone" })).status, 400);
    assert.equal((await request("/fixtureone/action", "POST", { action: "suspend", confirmName: "other" })).status, 400);
    for (const action of ["suspend", "resume"]) assert.equal((await request("/bulk/action", "POST", { ...bulk, action })).status, 202);
    assert.equal((await request("/fixtureone/action", "POST", { action: "resize", sku: "F4", confirmName: "fixtureone" })).status, 202);
    assert.equal(calls.filter(call => call[0] === "bulk").length, 2);
    assert.deepEqual(calls.find(call => call[0] === "change"), ["change", "fixtureone", "resize", "F4"]);
    assert.equal((await fetch(`${base}/api/admin/capacities/bulk/action`, { method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(bulk) })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});

it("limits persisted auto-resume policy to platform admins, requires explicit billing consent and audits the global setting", async context => {
  const user = { Id: randomUUID(), ObjectId: randomUUID(), DirectoryId: randomUUID(), TenantId: randomUUID(),
    DisplayName: "Tenant administrator", IsPlatformAdmin: false, IsTenantAdmin: true, DefaultPermissions: 127 } as User;
  const writes: unknown[][] = [], audits: unknown[][] = [];
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "admin@example.test" };
  });
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Repository.prototype, "audit", async (...args) => { audits.push(args); return []; });
  context.mock.method(CapacityPolicy.prototype, "refresh", async () =>
    ({ enabled: false, source: "deployment" as const, revision: null, available: true, issue: null }));
  context.mock.method(CapacityPolicy.prototype, "set", async (...args) => {
    writes.push(args);
    return { enabled: args[0], source: "platform" as const, revision: randomUUID(), available: true, issue: null };
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const route = `${base}/api/admin/capacities/auto-resume`;
  try {
    assert.equal((await fetch(route)).status, 401);
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf };
    const update = (body: unknown) => fetch(route, { method: "PUT", headers, body: JSON.stringify(body) });
    assert.equal((await fetch(route, { headers })).status, 403);
    assert.equal((await update({ enabled: true, revision: null, confirmBilling: true })).status, 403);
    user.IsPlatformAdmin = true;
    assert.equal((await fetch(route, { headers })).status, 200);
    for (const body of [{ enabled: true, revision: null }, { enabled: true, revision: null, confirmBilling: false },
      { enabled: "true", revision: null, confirmBilling: true }, { enabled: true, revision: null, confirmBilling: true, secretName: "web-client-secret" }])
      assert.equal((await update(body)).status, 400);
    assert.equal(writes.length, 0);
    assert.equal((await update({ enabled: true, revision: null, confirmBilling: true })).status, 200);
    assert.equal((await update({ enabled: false, revision: null })).status, 200);
    assert.deepEqual(writes, [[true, null], [false, null]]);
    assert.ok(audits.every(args => (args[0] as { TenantId: null }).TenantId === null));
    assert.deepEqual(audits.map(args => args[3]), ["Requested", "Applied", "Requested", "Applied"]);
    assert.equal((await fetch(route, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, revision: null, confirmBilling: true }) })).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
