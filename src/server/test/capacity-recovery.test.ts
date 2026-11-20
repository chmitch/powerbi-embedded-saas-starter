import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { capacityDemand, CapacityRecovery, sqlCapacityUnavailable, waitForCapacityData } from "../src/capacity-recovery.js";
import { AzureServices } from "../src/azure.js";
import { Database } from "../src/db.js";
import { config } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { FabricService } from "../src/fabric.js";
import { Repository } from "../src/repository.js";
import { createApp } from "../src/app.js";
import type { ContentItem, Tenant, User } from "../src/domain.js";

const resourceId = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/fixture/providers/Microsoft.Fabric/capacities/fixturecap";
const capacityId = "22222222-2222-4222-8222-222222222222";
const disabled = () => Object.assign(new Error("This SQL database has been disabled. Please reach out to your Fabric Capacity administrator."), { code: "ELOGIN" });
function fixture(states = ["Suspended", "Active"], enabled = true, timeout = 500) {
  const calls: string[] = [];
  let index = 0;
  const azure = { config: { ...config, AutoResumeCapacities: enabled, ManagementCapacityResourceId: resourceId },
    capacityResource: async (id: string, method = "GET") => {
      assert.equal(id, resourceId); calls.push(method);
      return { id, name: "fixturecap", properties: { state: states[Math.min(index++, states.length - 1)], provisioningState: "Succeeded" } };
    } } as unknown as AzureServices;
  const recovery = new CapacityRecovery(azure, { interval: 1, timeout });
  return { azure, recovery, calls };
}
it("coalesces concurrent paused-capacity recovery and does not wake from health/background contexts or when disabled", async () => {
  const test = fixture();
  assert.equal(await test.recovery.resume(resourceId), false);
  assert.deepEqual(test.calls, []);
  const results = await capacityDemand.run(true, () => Promise.all(Array.from({ length: 20 }, () => test.recovery.resume(resourceId))));
  assert.ok(results.every(Boolean));
  assert.equal(test.calls.filter(method => method === "POST").length, 1);
  assert.equal(await capacityDemand.run(true, () => test.recovery.resume(resourceId)), true);
  assert.equal(test.calls.filter(method => method === "POST").length, 1);
  const off = fixture(["Suspended"], false);
  assert.equal(await capacityDemand.run(true, () => off.recovery.resume(resourceId)), false);
  assert.deepEqual(off.calls, []);
});
it("does not resume active, disabled, or unrecognized capacities and bounds a stuck resume", async () => {
  for (const state of ["Active", "Disabled", "Failed", "Unknown"]) {
    const test = fixture([state]);
    assert.equal(await capacityDemand.run(true, () => test.recovery.resume(resourceId)), false);
    assert.deepEqual(test.calls, ["GET"]);
  }
  const stuck = fixture(["Suspended"], true, 15);
  await assert.rejects(capacityDemand.run(true, () => stuck.recovery.resume(resourceId)),
    (error: unknown) => error instanceof AppError && error.code === "CapacityStarting");
  assert.equal(stuck.calls.filter(method => method === "POST").length, 1);
});
it("does not recover ordinary SQL authorization errors or replay submitted writes", async () => {
  assert.equal(sqlCapacityUnavailable(new Error("Login failed for user.")), false);
  assert.equal(sqlCapacityUnavailable(disabled()), true);
  assert.equal(sqlCapacityUnavailable({ originalError: disabled() }), true);
  assert.equal(sqlCapacityUnavailable({ code: "ESOCKET" }), true);
  const test = fixture();
  const db = new Database(test.azure, test.recovery);
  let queries = 0;
  Object.assign(db, { connect: async () => ({ request: () => ({ query: async () => {
    queries++; if (queries === 1) throw disabled(); return { recordset: [{ ok: true }] };
  } }) }) });
  assert.deepEqual(await capacityDemand.run(true, () => db.read("SELECT 1")), [{ ok: true }]);
  assert.equal(queries, 2);
  assert.equal(test.calls.filter(method => method === "POST").length, 1);
  const writes = fixture();
  const writeDb = new Database(writes.azure, writes.recovery);
  let submissions = 0;
  Object.assign(writeDb, { connect: async () => ({ request: () => ({ query: async () => { submissions++; throw disabled(); } }) }) });
  await assert.rejects(capacityDemand.run(true, () => writeDb.query("UPDATE app.Settings SET Value='x'")), /disabled/);
  assert.equal(submissions, 1);
  assert.deepEqual(writes.calls, []);
  let attempts = 0;
  await assert.rejects(waitForCapacityData(async () => { attempts++; throw new Error("Permission denied"); },
    sqlCapacityUnavailable, { interval: 1, timeout: 5 }), /Permission denied/);
  assert.equal(attempts, 1);
});
it("keeps successful database reads on the fast path without any ARM calls", async () => {
  const test = fixture();
  const db = new Database(test.azure, test.recovery);
  Object.assign(db, { connect: async () => ({ request: () => ({ query: async () => ({ recordset: [1] }) }) }) });
  assert.deepEqual(await capacityDemand.run(true, () => db.read("SELECT 1")), [1]);
  assert.deepEqual(test.calls, []);
});
function tenantFixture() {
  const tenant = { Id: "tenant", WorkspaceId: "workspace" } as Tenant;
  const user = { Id: "user", TenantId: tenant.Id, DefaultPermissions: 127 } as User;
  const report = { Id: "report", TenantId: tenant.Id, ExternalId: "external-report", Kind: "Report",
    ModelExternalId: "external-model", Published: true } as ContentItem;
  const model = { Id: "model", TenantId: tenant.Id, ExternalId: "external-model", Kind: "Model", Published: true } as ContentItem;
  const test = fixture();
  test.azure.config.SubscriptionId = resourceId.split("/")[2]!;
  test.azure.config.ResourceGroup = "fixture";
  test.azure.config.ManagementCapacityResourceId = resourceId.replace("fixturecap", "managementcap");
  let mappingReads = 0, tokens = 0, failToken = false;
  let workspaceCapacity = capacityId;
  const bindings: unknown[] = [];
  const repo = {
    user: async () => ({ ...user }),
    tenant: async (id: string) => { assert.equal(id, tenant.Id); return tenant; },
    content: async () => [report, model],
    security: async () => ({ grants: [], nodes: [
      { Id: "root", TenantId: tenant.Id, ParentId: null },
      { Id: "report-node", TenantId: tenant.Id, ParentId: "root", ContentItemId: report.Id },
      { Id: "model-node", TenantId: tenant.Id, ParentId: "root", ContentItemId: model.Id },
    ] }),
    capacityBinding: async (value: Tenant) => {
      mappingReads++; assert.equal(value.Id, tenant.Id); return { capacityId, resourceId };
    },
    setCapacityBinding: async (_tenant: Tenant, value: unknown) => { bindings.push(value); },
  } as unknown as Repository;
  const service = new FabricService(repo, test.azure, test.recovery);
  service.runtimeToken = async () => "fixture-token";
  service.operator = async <T>(_token: string, suffix: string): Promise<T> => {
    if (suffix === "/capacities") return { value: [{ id: capacityId, displayName: "fixturecap" }] } as T;
    if (suffix === "/GenerateToken") {
      tokens++; if (failToken) { failToken = false; throw new AppError(502, "Upstream503", "Capacity unavailable"); }
      return { token: "fixture-embed-token", expiration: new Date().toISOString() } as T;
    }
    if (suffix.includes("/reports/")) return { datasetId: model.ExternalId, embedUrl: "https://app.powerbi.com/reportEmbed" } as T;
    if (suffix.includes("/datasets/")) return {} as T;
    return { id: tenant.WorkspaceId, isOnDedicatedCapacity: true, capacityId: workspaceCapacity } as T;
  };
  return { ...test, service, tenant, user, report, model, bindings, mappingReads: () => mappingReads, tokens: () => tokens,
    fail: () => { failToken = true; }, move: () => { workspaceCapacity = "other-capacity"; } };
}
it("wakes only the authorized tenant capacity after failure and reauthorizes token generation", async () => {
  const test = tenantFixture();
  await capacityDemand.run(true, () => test.service.embed(test.user, test.report.Id, "view"));
  assert.equal(test.mappingReads(), 0); assert.deepEqual(test.calls, []);
  test.fail();
  const result = await capacityDemand.run(true, () => test.service.embed(test.user, test.report.Id, "view"));
  assert.equal(result.id, test.report.ExternalId);
  assert.equal(result.targetWorkspaceId, undefined);
  assert.equal(test.calls.filter(method => method === "POST").length, 1);
  assert.equal(test.tokens(), 3);
  const denied = tenantFixture();
  await assert.rejects(capacityDemand.run(true, () => denied.service.embed(denied.user, "foreign-report", "view", true)), /your tenant/);
  await assert.rejects(capacityDemand.run(true, () => denied.service.embed({ ...denied.user, DefaultPermissions: 0 }, denied.report.Id, "view", true)), /permission/);
  await assert.rejects(capacityDemand.run(true, () => denied.service.createReport({ ...denied.user, DefaultPermissions: 0 }, denied.model.Id, true)), /permissions/);
  assert.equal(denied.mappingReads(), 0); assert.deepEqual(denied.calls, []);
});
it("rejects stale workspace mappings without resuming the old capacity and records verified bindings", async () => {
  const test = tenantFixture();
  test.move();
  await assert.rejects(capacityDemand.run(true, () => test.service.embed(test.user, test.report.Id, "view", true)), /capacity changed/);
  assert.deepEqual(test.calls, []);
  await test.service.cacheCapacityBinding(test.tenant, { id: test.tenant.WorkspaceId!, name: "Fixture", capacityId }, "fixture-token");
  assert.deepEqual(test.bindings, [null, { capacityId, resourceId }]);
});
it("rechecks authorization after a foreground capacity resume before issuing any new token", async () => {
  for (const creating of [false, true]) for (const forced of [false, true]) for (const revokeMembership of [false, true]) {
    const test = tenantFixture();
    const snapshot = { ...test.user };
    const original = test.azure.capacityResource.bind(test.azure);
    test.azure.capacityResource = async <T>(id: string, method: "GET" | "POST" = "GET"): Promise<T> => {
      if (method === "POST") {
        if (revokeMembership) test.user.TenantId = "other-tenant";
        else test.user.DefaultPermissions = 0;
      }
      return original<T>(id, method);
    };
    if (!forced) test.fail();
    await assert.rejects(capacityDemand.run(true, () => creating
      ? test.service.createReport(snapshot, test.model.Id, forced)
      : test.service.embed(snapshot, test.report.Id, "view", forced)), revokeMembership ? /membership/ : /permission/);
    assert.equal(test.tokens(), forced ? 0 : 1);
    assert.equal(test.calls.filter(method => method === "POST").length, 1);
  }
});
it("does not wake on health probes but recovers an anonymous first-visit bootstrap read without SQL-backed authentication", async context => {
  context.mock.method(AzureServices.prototype, "secret", async () => "fixture-only-session-key");
  const arm: string[] = [];
  let paused = true, failed = false;
  context.mock.method(AzureServices.prototype, "capacityResource", async (id, method = "GET") => {
    arm.push(method); if (method === "POST") paused = false;
    return { id, properties: { state: paused ? "Suspended" : "Active", provisioningState: "Succeeded" } };
  });
  context.mock.method(Database.prototype, "query", async text => {
    if (text.includes("SchemaVersions")) throw disabled();
    if (text.includes("BootstrapCompleted") && !failed) { failed = true; throw disabled(); }
    return [];
  });
  const { app, db, stopBackground } = await createApp({ ...config, AutoResumeCapacities: true,
    ManagementCapacityResourceId: resourceId, DirectoryTenantId: "fixture", WebClientId: "fixture",
    BootstrapObjectId: "fixture", SqlServer: "fixture", SqlDatabase: "fixture", LocalSecretsPath: "",
    KeyVaultUri: "https://fixture-only.vault.azure.net" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/`);
    assert.deepEqual(arm, []);
    assert.equal((await fetch(`${base}/health/ready`)).status, 500);
    assert.deepEqual(arm, []);
    assert.equal((await fetch(`${base}/api/session`)).status, 200);
    assert.equal(arm.filter(method => method === "POST").length, 1);
  } finally { stopBackground(); await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
