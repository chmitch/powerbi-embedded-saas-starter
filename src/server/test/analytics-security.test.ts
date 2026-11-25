import { it, type TestContext } from "node:test";
import sql from "mssql";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { analyticsConfigured, AnalyticsProvisioner, isAnalyticsSelectDenied, mapAnalyticsPrincipal, setupAnalyticsSecurity } from "../src/analytics-security.js";
import { config } from "../src/config.js";
import type { Repository } from "../src/repository.js";
import type { AzureServices } from "../src/azure.js";
import type { FabricService } from "../src/fabric.js";
import type { Executor, Params } from "../src/db.js";
import { AppError } from "../src/errors.js";
import type { Tenant } from "../src/domain.js";
import { assertNotManagementResource } from "../src/domain.js";

const tenant = { Id: randomUUID(), EmbeddingClientId: randomUUID(), EmbeddingObjectId: randomUUID(),
  WorkspaceId: randomUUID() } as Tenant;
const pins = { ...config, AgentWorkspaceId: randomUUID(), ManagementWorkspaceId: randomUUID(),
  AnalyticsReaderGroupId: randomUUID(), AnalyticsReaderGroupName: "test-analytics-readers",
  AnalyticsEndpointId: randomUUID(), AnalyticsSqlServer: "test.datawarehouse.fabric.microsoft.com", AnalyticsSqlDatabase: "test" };

it("rejects partial analytics pins and protects the agent workspace from tenant embedding/adoption", () => {
  assert.equal(analyticsConfigured({ ...config, AgentWorkspaceId: "", AnalyticsReaderGroupId: "",
    AnalyticsReaderGroupName: "", AnalyticsEndpointId: "", AnalyticsSqlServer: "", AnalyticsSqlDatabase: "" }), false);
  assert.throws(() => analyticsConfigured({ ...pins, AnalyticsEndpointId: "" }), /Complete the pinned/);
  assert.throws(() => analyticsConfigured({ ...pins, AgentWorkspaceId: pins.ManagementWorkspaceId }), /management workspace/);
  assert.throws(() => assertNotManagementResource(pins.AgentWorkspaceId, pins.ManagementWorkspaceId, pins.AgentWorkspaceId));
});

it("binds analytics mappings only to valid persisted tenant principal IDs and refuses rebinding", async () => {
  const calls: { text: string; params?: Params }[] = [];
  const db = { query: async (text, params) => { calls.push({ text, params }); return []; } } as Executor;
  await mapAnalyticsPrincipal(db, tenant);
  assert.deepEqual(calls[0]!.params, { tenantId: tenant.Id, clientId: tenant.EmbeddingClientId, objectId: tenant.EmbeddingObjectId });
  assert.match(calls[0]!.text, /THROW 51001/);
  await assert.rejects(mapAnalyticsPrincipal(db, { ...tenant, EmbeddingClientId: null }));
  assert.equal(calls.length, 1);
});

it("reuses the tenant principal, configures only Contributor access in the agent workspace, and preserves existing roles on retry", async context => {
  let member = false, assigned = false, broad = false;
  const writes: string[] = [];
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = String(input);
    assert.ok(url.startsWith(`https://graph.microsoft.com/v1.0/groups/${pins.AnalyticsReaderGroupId}/members/`));
    if (options?.method === "POST") {
      assert.equal(JSON.parse(String(options.body))["@odata.id"],
        `https://graph.microsoft.com/v1.0/directoryObjects/${tenant.EmbeddingObjectId}`);
      writes.push("group"); member = true; return new Response(null, { status: 204 });
    }
    return member ? Response.json({ id: tenant.EmbeddingObjectId }) : new Response(null, { status: 404 });
  });

  const repo = { tenant: async () => tenant, db: { query: async () => [] } } as unknown as Repository;
  const azure = { config: pins, provisioner: { getToken: async () => ({ token: "test-only" }) } } as unknown as AzureServices;
  const fabric = { operator: async (_token: string, path: string, method = "GET", body?: unknown) => {
    if (path.includes(pins.ManagementWorkspaceId)) return { value: broad ? [{ identifier: tenant.EmbeddingObjectId }] : [] };
    assert.equal(path, `/groups/${pins.AgentWorkspaceId}/users`);
    if (method === "POST") {
      assert.deepEqual(body, { identifier: tenant.EmbeddingObjectId, groupUserAccessRight: "Contributor", principalType: "App" });
      writes.push("workspace"); assigned = true; return {};
    }
    return { value: assigned ? [{ identifier: tenant.EmbeddingObjectId, groupUserAccessRight: "Contributor" }] : [] };
  } } as unknown as FabricService;
  const service = new AnalyticsProvisioner(repo, azure, fabric);
  await service.ensure(tenant.Id, "operator"); await service.ensure(tenant.Id, "operator");
  assert.deepEqual(writes, ["group", "workspace"]);
  broad = true;
  await assert.rejects(service.ensure(tenant.Id, "operator"),
    error => error instanceof AppError && error.code === "AnalyticsPermissionsTooBroad");
});

function endpoint(context: TestContext, options: { missing?: boolean; changed?: boolean; disabled?: boolean; existing?: boolean } = {}) {
  const writes: string[] = [];
  const tables = ["Tenants", "Users", "Content", "Nodes", "Grants", "ReportRequests", "ReportRenders"];
  context.mock.method(sql.ConnectionPool.prototype, "connect", async function () { return this; });
  context.mock.method(sql.ConnectionPool.prototype, "close", async () => {});
  context.mock.method(sql.ConnectionPool.prototype, "request", () => {
    const request = {
      input: () => request,
      query: async (text: string) => {
        let recordset: unknown[] = [];
        if (text === "SELECT DB_NAME() AS name") recordset = [{ name: pins.AnalyticsSqlDatabase }];
        else if (text.startsWith("SELECT OBJECT_ID")) recordset = [{ id: options.missing ? null : 1 }];
        else if (text.includes("FROM sys.tables")) recordset = tables.map((_, id) => ({ id }));
        else if (text.includes("FROM sys.security_policies") && (options.changed || options.disabled || options.existing)) {
          recordset = tables.map((tableName, targetId) => ({
            tableName, targetId, enabled: !options.disabled, predicateType: 0,
            definition: `([analytics].[TenantPrincipalPredicate]([${tableName === "Tenants" || options.changed ? "Id" : "TenantId"}]))`,
          }));
        } else if (!text.startsWith("SELECT")) writes.push(text);
        return { recordset };
      },
    };
    return request as unknown as sql.Request;
  });
  return { writes, credential: { getToken: async () => ({ token: "test-only", expiresOnTimestamp: Date.now() + 60_000 }) } };
}

it("installs default-deny endpoint RLS before granting only curated views and denying operational tables", async context => {
  const { writes, credential } = endpoint(context);
  await setupAnalyticsSecurity(pins, credential);
  const predicate = writes.find(text => text.startsWith("CREATE FUNCTION"))!;
  assert.match(predicate, /WITH SCHEMABINDING/);
  assert.match(predicate, /p\.TenantId=@TenantId AND/);
  assert.match(predicate, /SUSER_SID\(\)/);
  assert.match(predicate, /CONVERT\(binary\(16\),CONVERT\(uniqueidentifier,p.ClientId\)\)/);
  assert.match(predicate, /CONVERT\(binary\(16\),CONVERT\(uniqueidentifier,p.ObjectId\)\)/);
  assert.doesNotMatch(predicate, /SESSION_CONTEXT|IS_MEMBER|dbo/);
  const policy = writes.findIndex(text => text.startsWith("CREATE SECURITY POLICY"));
  assert.match(writes[policy]!, /TenantPrincipalPredicate\(Id\) ON app.Tenants/);
  assert.match(writes[policy]!, /TenantPrincipalPredicate\(TenantId\) ON app.Users/);
  assert.match(writes[policy]!, /STATE=ON,SCHEMABINDING=ON/);
  assert.ok(writes.findIndex(text => text.startsWith("GRANT")) > policy);
  assert.equal(writes.filter(text => text.startsWith("GRANT")).length, 5);
  assert.ok(writes.filter(text => text.startsWith("GRANT")).every(text => text.includes("OBJECT::analytics.")));
  assert.ok(writes.includes("DENY SELECT ON OBJECT::app.AnalyticsPrincipalTenants TO [test-analytics-readers]"));
  assert.ok(writes.includes("DENY SELECT ON OBJECT::app.Sessions TO [test-analytics-readers]"));
});

it("refuses missing mirrored tables, disabled policies and predicates on the wrong tenant column before granting reads", async context => {
  for (const options of [{ missing: true }, { changed: true }, { disabled: true }]) {
    const { writes, credential } = endpoint(context, options);
    await assert.rejects(setupAnalyticsSecurity(pins, credential),
      error => error instanceof AppError && error.code === (options.missing ? "AnalyticsReplicationPending" : "AnalyticsPolicyChanged"));
    assert.equal(writes.filter(text => text.startsWith("GRANT")).length, 0);
    context.mock.restoreAll();
  }
});

it("accepts SQL's parenthesized existing filter metadata without replacing an active policy", async context => {
  const { writes, credential } = endpoint(context, { existing: true });
  await setupAnalyticsSecurity(pins, credential);
  assert.equal(writes.filter(text => text.startsWith("CREATE SECURITY POLICY")).length, 0);
  assert.equal(writes.filter(text => text.startsWith("GRANT")).length, 5);
});

it("rejects inherited management-workspace group access before adding tenant permissions", async context => {
  const managementGroup = randomUUID();
  context.mock.method(globalThis, "fetch", async input => {
    assert.equal(String(input), `https://graph.microsoft.com/v1.0/groups/${managementGroup}/transitiveMembers?$select=id&$top=999`);
    return Response.json({ value: [{ id: tenant.EmbeddingObjectId }] });
  });
  const repo = { tenant: async () => tenant, db: { query: async () => [] } } as unknown as Repository;
  const azure = { config: pins, provisioner: { getToken: async () => ({ token: "test-only" }) } } as unknown as AzureServices;
  const fabric = { operator: async (_token: string, path: string, method = "GET") => {
    assert.equal(method, "GET");
    assert.equal(path, `/groups/${pins.ManagementWorkspaceId}/users`);
    return { value: [{ identifier: managementGroup, principalType: "Group" }] };
  } } as unknown as FabricService;
  await assert.rejects(new AnalyticsProvisioner(repo, azure, fabric).ensure(tenant.Id, "operator"),
    error => error instanceof AppError && error.code === "AnalyticsPermissionsTooBroad");
});

it("recognizes Fabric SELECT denial without mistaking missing tables or connectivity failures for isolation", () => {
  assert.equal(isAnalyticsSelectDenied({ number: 229 }), true);
  assert.equal(isAnalyticsSelectDenied({ number: 373,
    message: "The SELECT permission or external policy action 'Microsoft.Sql/Sqlservers/Databases/Schemas/Tables/Rows/Select' was denied on the object 'Sessions'." }), true);
  assert.equal(isAnalyticsSelectDenied({ number: 373, message: "An unrelated policy action failed" }), false);
  assert.equal(isAnalyticsSelectDenied({ number: 208, message: "Invalid object name" }), false);
  assert.equal(isAnalyticsSelectDenied(new Error("Connection failed")), false);
});
