import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/auth.js";
import { AzureServices } from "../src/azure.js";
import { Database, type Params } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { AppError } from "../src/errors.js";
import type { User } from "../src/domain.js";

it("registers tenant users by exact UPN or manual ID, preserving permissions and enforcing membership and admin boundaries", async context => {
  const tenantId = "11111111-1111-4111-8111-111111111111", otherTenantId = "22222222-2222-4222-8222-222222222222";
  const objectId = "33333333-3333-4333-8333-333333333333", manualId = "44444444-4444-4444-8444-444444444444";
  const user: User = { Id: "operator", TenantId: tenantId, ObjectId: "operator", DirectoryId: "directory",
    DisplayName: "Tenant admin", IsPlatformAdmin: false, IsTenantAdmin: true, DefaultPermissions: 0 };
  const lookups: string[] = [], inserts: Params[] = [], audits: unknown[][] = [];
  let registered = false;
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: user.ObjectId, directoryId: user.DirectoryId, name: user.DisplayName, username: "admin@contoso.com" };
  });
  context.mock.method(Repository.prototype, "user", async () => user);
  context.mock.method(Repository.prototype, "audit", async (...args) => { audits.push(args); });
  context.mock.method(AzureServices.prototype, "resolveUserPrincipalName", async upn => {
    lookups.push(upn);
    if (upn === "missing@contoso.com") throw new AppError(404, "DirectoryUserNotFound", "No exact UPN match.");
    if (upn === "denied@contoso.com") throw new AppError(503, "DirectoryLookupForbidden", "Directory lookup unavailable; use manual ID.");
    return { objectId, displayName: "Directory user" };
  });
  context.mock.method(Database.prototype, "query", async (text, params) => {
    if (text.startsWith("SELECT Id FROM app.Users")) return registered ? [{ Id: "existing" }] : [];
    assert.ok(text.startsWith("INSERT app.Users"));
    inserts.push(params); return [];
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
    const register = (body: unknown, tenant = tenantId) => fetch(`${base}/api/tenants/${tenant}/users`,
      { method: "POST", headers, body: JSON.stringify(body) });
    const upn = { userPrincipalName: "member@contoso.com", permissions: 9 };
    assert.equal((await register({ ...upn, userPrincipalName: " member@contoso.com " })).status, 201);
    assert.deepEqual(lookups, ["member@contoso.com"]);
    assert.equal(inserts[0]!.objectId, objectId); assert.equal(inserts[0]!.displayName, "Directory user");
    assert.equal(inserts[0]!.permissions, 9); assert.equal(inserts[0]!.id, tenantId);
    assert.equal(inserts[0]!.userPrincipalName, undefined); assert.equal(inserts[0]!.isTenantAdmin, undefined);
    assert.equal(audits[0]![2], objectId);
    for (const body of [
      { ...upn, objectId, displayName: "Override" }, { ...upn, displayName: "Override" },
      { ...upn, isTenantAdmin: true }, { ...upn, isPlatformAdmin: true }, { ...upn, permissions: 128 },
      { userPrincipalName: "invalid" },
    ]) assert.equal((await register(body)).status, 400);
    assert.equal(lookups.length, 1); assert.equal(inserts.length, 1);
    registered = true;
    assert.equal((await register(upn)).status, 409);
    assert.equal((await register({ objectId: manualId, displayName: "Already registered elsewhere" })).status, 409);
    registered = false;
    assert.equal((await register({ userPrincipalName: "missing@contoso.com" })).status, 404);
    assert.equal((await register({ userPrincipalName: "denied@contoso.com" })).status, 503);
    assert.equal(inserts.length, 1);
    const beforeManual = lookups.length;
    assert.equal((await register({ objectId: manualId, displayName: "Manual user", permissions: 17 })).status, 201);
    assert.equal(lookups.length, beforeManual); assert.equal(inserts[1]!.objectId, manualId); assert.equal(inserts[1]!.permissions, 17);
    assert.equal((await register({ userPrincipalName: "default@contoso.com" })).status, 201);
    assert.equal(inserts[2]!.permissions, 0);
    const authorizedLookups = lookups.length;
    assert.equal((await register(upn, otherTenantId)).status, 403);
    user.IsTenantAdmin = false;
    assert.equal((await register(upn)).status, 403);
    user.IsPlatformAdmin = true; user.TenantId = null;
    assert.equal((await register(upn)).status, 403);
    assert.equal(lookups.length, authorizedLookups); assert.equal(inserts.length, 3); assert.equal(audits.length, 3);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
