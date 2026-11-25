import { it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildDemoData, demoMarkerName, demoReportKeys, manageDemoData } from "../src/demo-data.js";
import { FabricService } from "../src/fabric.js";
import type { Repository } from "../src/repository.js";
import type { AzureServices } from "../src/azure.js";
import { effectivePermissions, Permission, type Grant, type NavigationNode, type User } from "../src/domain.js";
import type { Database, Executor, Params } from "../src/db.js";

const tenantId = randomUUID(), workspaceId = randomUUID(), rootId = randomUUID();
const anchor = new Date("2026-11-24T18:00:00.000Z");

it("generates disjoint, repeatable demo records without real login identities, published content or administrator roles", () => {
  const data = buildDemoData(tenantId, workspaceId, rootId, anchor);
  assert.deepEqual(buildDemoData(tenantId.toUpperCase(), workspaceId, rootId, anchor).users.map(user => user.Id), data.users.map(user => user.Id));
  assert.deepEqual(buildDemoData(tenantId, workspaceId, rootId, anchor), data);
  const other = buildDemoData(randomUUID(), randomUUID(), randomUUID(), anchor);
  const ids = new Set(Object.values(data).flat().map(row => row.Id).filter(Boolean));
  for (const row of Object.values(other).flat()) if (row.Id) assert.ok(!ids.has(row.Id));
  assert.equal(data.users.length, 15);
  assert.equal(data.reports.length, 10);
  for (const user of data.users) {
    assert.equal(user.IsTenantAdmin, false); assert.equal(user.IsPlatformAdmin, false); assert.equal(user.DefaultPermissions, 0);
    assert.match(String(user.DisplayName), /^\[DEMO\]/);
    assert.notEqual(user.DirectoryId, tenantId);
  }
  for (const report of data.reports) {
    assert.equal(report.Published, false); assert.equal(report.EmbedUrl, null);
    assert.equal(report.ModelExternalId, null); assert.equal(report.UnsafeDependency, true);
    assert.match(String(report.Name), /^\[DEMO\]/);
  }
  assert.equal(data.nodes[0]!.BreakInheritance, true);
  for (const grant of data.grants) {
    assert.ok(data.users.some(user => user.Id === grant.UserId));
    assert.ok(data.nodes.some(node => node.Id === grant.NodeId));
    assert.equal(grant.TenantId, tenantId);
  }
});

it("creates linked historical attempts/renders, permission-consistent successes, unused reports and inactive users", () => {
  const data = buildDemoData(tenantId, workspaceId, rootId, anchor);
  assert.equal(data.requests.length, 3000);
  assert.ok(data.renders.length > 2600 && data.renders.length < 2800);
  assert.deepEqual(new Set(data.requests.map(request => request.Status)), new Set(["Rendered", "Failed", "Authorized", "Requested"]));
  const renders = new Map(data.renders.map(render => [render.Id, render]));
  const start = Date.parse("2026-08-27T00:00:00.000Z");
  for (const request of data.requests) {
    assert.ok(Date.parse(String(request.ServerReceivedAt)) >= start);
    assert.ok(Date.parse(String(request.RecordedAt)) <= anchor.getTime());
    const render = renders.get(request.RenderId);
    assert.equal(Boolean(render), request.Status === "Rendered");
    if (!render) continue;
    for (const field of ["TenantId", "UserId", "ContentId", "RequestedAt", "ServerReceivedAt", "Mode"])
      assert.equal(render[field], request[field]);
    assert.equal(Date.parse(String(render.RenderedAt)) - Date.parse(String(render.RequestedAt)), render.DurationMs);
    const user = data.users.find(user => user.Id === request.UserId)!;
    const node = data.nodes.find(node => node.ContentItemId === request.ContentId)!;
    const mask = effectivePermissions(user as unknown as User, String(node.Id),
      data.nodes as unknown as NavigationNode[], data.grants as unknown as Grant[]);
    assert.ok(mask & Permission.ViewReport);
    if (render.Mode !== "view") assert.ok(mask & Permission.EditReport);
    if (render.Mode === "copy") assert.ok(mask & Permission.CopyReport);
  }
  for (const report of data.reports.slice(8)) assert.ok(!data.requests.some(request => request.ContentId === report.Id));
  assert.ok(!data.requests.some(request => request.UserId === data.users[14]!.Id));
  assert.ok(data.renders.some(render => Number(render.DurationMs) > 15_000));
  assert.equal(new Set(data.requests.map(request => String(request.ServerReceivedAt).slice(0, 10))).size, 90);
});

function database(marker?: string, restoredReports = 0) {
  const calls: { text: string; params: Params }[] = [];
  const tx = { query: async (text: string, params: Params = {}) => {
    calls.push({ text, params });
    if (text.startsWith("SELECT t.Id")) return [{ Id: tenantId, WorkspaceId: workspaceId, RootId: rootId }];
    if (text.startsWith("SELECT Value")) return String(params.name).startsWith("DemoSamplesBound:") ? [] : marker ? [{ Value: marker }] : [];
    if (text.includes("SELECT @@ROWCOUNT AS restored")) return [{ restored: restoredReports }];
    return [];
  } } as Executor;
  const db = { transaction: async <T>(work: (tx: Executor) => Promise<T>) => work(tx) } as Pick<Database, "transaction">;
  return { db, calls };
}
const manifest = JSON.stringify({ version: 1, anchor: anchor.toISOString(), workspaceId, rootId });

it("previews without writes and seeds only exact demo records with a manifest and audit in one transaction", async () => {
  const preview = database();
  await manageDemoData(preview.db, [tenantId], "preview", anchor);
  assert.ok(!preview.calls.some(call => /\bINSERT\b|\bDELETE\b|\bUPDATE\b/.test(call.text)));
  const seeded = database();
  const results = await manageDemoData(seeded.db, [tenantId], "apply", anchor);
  assert.equal(results[0]!.changed, true);
  const inserts = seeded.calls.filter(call => call.text.startsWith("INSERT app."));
  assert.equal(inserts.length, 8);
  assert.equal(inserts[0]!.text.startsWith("INSERT app.Users"), true);
  assert.equal(inserts[5]!.text.startsWith("INSERT app.ReportRenders"), true);
  assert.ok(!seeded.calls.some(call => /\bUPDATE\b|\bDELETE\b/.test(call.text)));
});

it("reruns without duplicate inserts, rejects changed manifests and removes only manifest-owned keys in dependency order", async () => {
  const existing = database(manifest);
  const result = await manageDemoData(existing.db, [tenantId], "apply", new Date("2026-12-01"));
  assert.equal(result[0]!.changed, false);
  assert.ok(!existing.calls.some(call => /\b(?:INSERT|DELETE)\s+(?:app\.|a\s+FROM\s+app\.)/.test(call.text)));
  assert.equal(existing.calls.filter(call => call.text.includes("EXCEPT")).length, 6);
  const changed = database(JSON.stringify({ version: 1, anchor: anchor.toISOString(), workspaceId: randomUUID(), rootId }));
  await assert.rejects(manageDemoData(changed.db, [tenantId], "remove"), { code: "DemoTenantChanged" });
  assert.ok(!changed.calls.some(call => /\bDELETE\b/.test(call.text)));
  const cleanup = database(manifest);
  await manageDemoData(cleanup.db, [tenantId], "remove");
  const deletes = cleanup.calls.filter(call => call.text.startsWith("DELETE"));
  assert.match(deletes[0]!.text, /app.ReportRenders/);
  assert.match(deletes[1]!.text, /app.ReportRequests/);
  assert.match(deletes[2]!.text, /app.Grants/);
  for (const call of deletes) {
    assert.ok(call.text.includes("JOIN OPENJSON") || call.text.includes("Id=@id AND TenantId=@tenantId") || call.text.includes("Name=@name"));
  }
  await assert.rejects(manageDemoData(cleanup.db, [tenantId, tenantId.toUpperCase()], "apply"), { code: "InvalidDemoTenants" });
});

it("restores only sync-deleted manifest-owned reports after validating every other field", async () => {
  const synced = database(manifest, 10);
  const [result] = await manageDemoData(synced.db, [tenantId], "apply");
  assert.equal(result!.changed, true); assert.equal(result!.restoredReports, 10);
  const update = synced.calls.find(call => call.text.includes("UPDATE a SET Deleted=0"))!;
  assert.match(update.text, /JOIN OPENJSON/);
  assert.match(update.text, /WHERE a.Deleted=1/);
  const checks = synced.calls.filter(call => call.text.includes("EXCEPT"));
  assert.equal(checks.length, 6);
  const reportCheck = checks.find(call => call.text.includes("FROM app.Content"))!;
  assert.match(reportCheck.text, /\[Published\]/);
  assert.match(reportCheck.text, /\[ExternalId\]/);
  assert.ok(!reportCheck.text.includes("SELECT [Id],[TenantId],[ExternalId],[Kind],[Name],[ModelExternalId],[EmbedUrl],[Published],[Deleted]"));
});

it("workspace synchronization exempts only exact manifest-bound unpublished demo keys, not a name prefix or arbitrary content", async context => {
  const calls: { text: string; params: Params }[] = [];
  const tx = { query: async (text: string, params: Params = {}) => {
    calls.push({ text, params }); return text.startsWith("SELECT Id FROM app.Nodes") ? [{ Id: rootId }] : [];
  } } as Executor;
  const repo = { tenant: async () => ({ Id: tenantId, WorkspaceId: workspaceId }),
    db: { transaction: async <T>(work: (tx: Executor) => Promise<T>) => work(tx) } } as unknown as Repository;
  const service = new FabricService(repo, {} as AzureServices);
  context.mock.method(service, "runtimeToken", async () => "test-only");
  context.mock.method(service, "operator", async () => ({ value: [] }));
  await service.sync(tenantId);
  const update = calls.find(call => call.text.startsWith("UPDATE c SET Deleted=1"))!;
  assert.equal(update.params.demoMarker, demoMarkerName(tenantId));
  assert.deepEqual(JSON.parse(String(update.params.demoReports)), demoReportKeys(tenantId));
  assert.equal(update.params.workspaceId, workspaceId); assert.equal(update.params.rootId, rootId);
  assert.match(update.text, /s.Name=@demoMarker/);
  assert.match(update.text, /d.Id=c.Id AND d.ExternalId=c.ExternalId/);
  assert.match(update.text, /c.Published=0/);
  assert.match(update.text, /c.EmbedUrl IS NULL AND c.ModelExternalId IS NULL/);
});
