import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sql from "mssql";
import { ClientSecretCredential } from "@azure/identity";
import { TenantAnalytics } from "../src/analytics-security.js";
import { config } from "../src/config.js";
import type { AzureServices } from "../src/azure.js";
import type { Repository } from "../src/repository.js";
import type { Tenant } from "../src/domain.js";

const pins = { ...config, DirectoryTenantId: randomUUID(), AgentWorkspaceId: randomUUID(), ManagementWorkspaceId: randomUUID(),
  AnalyticsReaderGroupId: randomUUID(), AnalyticsReaderGroupName: "test-analytics-readers",
  AnalyticsEndpointId: randomUUID(), AnalyticsSqlServer: "test.datawarehouse.fabric.microsoft.com", AnalyticsSqlDatabase: "test" };
const tenants = [1, 2].map(n => ({ Id: randomUUID(), EmbeddingClientId: randomUUID(),
  EmbeddingObjectId: randomUUID(), SecretName: `tenant-${n}` } as Tenant));

function fixture(context: TestContext, identity = { matched: 1, databaseControl: 0, schemaAlter: 0 }) {
  const identities: Record<string, unknown>[] = [], secrets: string[] = [];
  let closed = 0;
  context.mock.method(ClientSecretCredential.prototype, "getToken", async scope => {
    assert.equal(scope, "https://database.windows.net/.default");
    return { token: "tenant-test-token", expiresOnTimestamp: Date.now() + 60_000 };
  });
  context.mock.method(sql.ConnectionPool.prototype, "connect", async function () { return this; });
  context.mock.method(sql.ConnectionPool.prototype, "close", async () => { closed++; });
  context.mock.method(sql.ConnectionPool.prototype, "request", () => {
    const inputs: Record<string, unknown> = {};
    const request = {
      input: (name: string, typeOrValue: unknown, value?: unknown) => {
        inputs[name] = value === undefined ? typeOrValue : value;
        return request;
      },
      query: async (text: string) => {
        if (text === "SELECT DB_NAME() AS name") return { recordset: [{ name: pins.AnalyticsSqlDatabase }] };
        if (text.includes("SUSER_SID()")) { identities.push(inputs); return { recordset: [identity] }; }
        assert.match(text, /analytics\./);
        return { recordset: [{ value: 7 }] };
      },
    };
    return request as unknown as sql.Request;
  });
  const repo = { tenant: async (id: string) => {
    const tenant = tenants.find(t => t.Id === id);
    assert.ok(tenant); return tenant;
  } } as unknown as Repository;
  const azure = { config: pins, secret: async (name: string) => { secrets.push(name); return "test-only-secret"; },
    runtime: { getToken: () => assert.fail("Tenant analytics must not authenticate with the runtime managed identity") } } as unknown as AzureServices;
  return { service: new TenantAnalytics(repo, azure), identities, secrets, closed: () => closed };
}

it("opens tenant-principal connections using persisted credential references and closes each request independently", async context => {
  const f = fixture(context);
  for (const tenant of tenants) {
    const result = await f.service.withTenant(tenant.Id, reader => reader.read("SELECT value FROM analytics.Reports"));
    assert.deepEqual(result, [{ value: 7 }]);
  }
  assert.deepEqual(f.secrets, tenants.map(t => t.SecretName));
  assert.deepEqual(f.identities, tenants.map(t => ({ clientId: t.EmbeddingClientId, objectId: t.EmbeddingObjectId })));
  assert.equal(f.closed(), 2);
  await assert.rejects(f.service.withTenant(tenants[0]!.Id, async () => { throw new Error("SQL query failed"); }), /SQL query failed/);
  assert.equal(f.closed(), 3);
});

it("refuses a wrong principal or security-altering SQL privileges before retrieving insight data", async context => {
  for (const identity of [{ matched: 0, databaseControl: 0, schemaAlter: 0 },
    { matched: 1, databaseControl: 1, schemaAlter: 0 }, { matched: 1, databaseControl: 0, schemaAlter: 1 }]) {
    const f = fixture(context, identity);
    await assert.rejects(f.service.withTenant(tenants[0]!.Id, async () => assert.fail("No insight query should run")),
      { code: identity.matched ? "AnalyticsPermissionsTooBroad" : "AnalyticsIdentityMismatch" });
    assert.equal(f.closed(), 1);
    context.mock.restoreAll();
  }
});

it("does not fall back to shared SQL when analytics is unconfigured", async () => {
  const repo = { tenant: () => assert.fail("No credential lookup before configuration validation") } as unknown as Repository;
  const azure = { config: { ...config, AgentWorkspaceId: "", AnalyticsReaderGroupId: "", AnalyticsReaderGroupName: "",
    AnalyticsEndpointId: "", AnalyticsSqlServer: "", AnalyticsSqlDatabase: "" } } as unknown as AzureServices;
  await assert.rejects(new TenantAnalytics(repo, azure).withTenant(tenants[0]!.Id,
    async () => assert.fail("No insight query")), { code: "AnalyticsNotConfigured" });
});
