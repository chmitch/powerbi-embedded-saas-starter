import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import type { AzureServices } from "../src/azure.js";
import { config } from "../src/config.js";
import type { Tenant, User } from "../src/domain.js";
import { AppError } from "../src/errors.js";
import { FabricService } from "../src/fabric.js";
import type { Repository } from "../src/repository.js";

function fixture() {
  const tenant = { Id: randomUUID(), WorkspaceId: randomUUID(), EmbeddingObjectId: randomUUID() } as Tenant;
  const users: { identifier: string; groupUserAccessRight: string }[] = [];
  const calls: { path: string; method: string; body: unknown }[] = [], audits: string[] = [];
  let denyWrite = false, denyAudit = false;
  const repo = {
    tenant: async () => structuredClone(tenant),
    audit: async (_actor: User, _action: string, _resource: string, outcome: string) => {
      if (denyAudit) throw new Error("Audit unavailable");
      audits.push(outcome);
    },
  } as unknown as Repository;
  const azure = { config: { ...config, ManagementWorkspaceId: randomUUID() } } as AzureServices;
  const service = new FabricService(repo, azure);
  service.operator = async <T>(_token: string, path: string, method = "GET", body?: unknown) => {
    calls.push({ path, method, body });
    if (method === "GET") return { value: structuredClone(users) } as T;
    if (denyWrite) throw new AppError(502, "Upstream403", "Denied");
    return {} as T;
  };
  const actor = { Id: randomUUID(), TenantId: null } as User;
  return { tenant, users, calls, audits, azure,
    repair: () => service.repairWorkspaceAccess(tenant.Id, "operator", tenant.WorkspaceId!, tenant.EmbeddingObjectId!, actor),
    service, actor, denyWrite: () => { denyWrite = true; }, denyAudit: () => { denyAudit = true; } };
}

it("adds missing configured principal access, updates existing membership and skips already-correct Admin access", async () => {
  const f = fixture();
  assert.equal((await f.repair()).status, "applied");
  f.users.push({ identifier: f.tenant.EmbeddingObjectId!.toUpperCase(), groupUserAccessRight: "Viewer" });
  assert.equal((await f.repair()).status, "applied");
  f.users[0]!.groupUserAccessRight = "Admin";
  assert.equal((await f.repair()).status, "skipped");
  const writes = f.calls.filter(call => call.method !== "GET");
  assert.deepEqual(writes.map(call => call.method), ["POST", "PUT"]);
  assert.ok(writes.every(call => call.path === `/groups/${f.tenant.WorkspaceId}/users`));
  assert.deepEqual(writes[0]!.body, { identifier: f.tenant.EmbeddingObjectId, groupUserAccessRight: "Admin", principalType: "App" });
  assert.deepEqual(f.audits, ["Requested", "Applied", "Requested", "Applied", "Skipped"]);
});

it("rejects stale scope confirmations, protected workspaces and ambiguous membership before any repair write", async () => {
  const f = fixture();
  await assert.rejects(f.service.repairWorkspaceAccess(f.tenant.Id, "operator", randomUUID(), f.tenant.EmbeddingObjectId!, f.actor),
    { code: "TenantConfigurationChanged" });
  await assert.rejects(f.service.repairWorkspaceAccess(f.tenant.Id, "operator", f.tenant.WorkspaceId!, randomUUID(), f.actor),
    { code: "TenantConfigurationChanged" });
  f.users.push(...Array.from({ length: 2 }, () => ({ identifier: f.tenant.EmbeddingObjectId!, groupUserAccessRight: "Viewer" })));
  await assert.rejects(f.repair(), { code: "WorkspaceAccessUnverified" });
  f.tenant.WorkspaceId = f.azure.config.ManagementWorkspaceId;
  await assert.rejects(f.repair(), { code: "ProtectedManagementResource" });
  f.azure.config.ManagementWorkspaceId = "";
  await assert.rejects(f.repair(), { code: "MissingManagementConfiguration" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

it("does not replay uncertain access writes and fails closed when the pre-write audit is unavailable", async () => {
  const f = fixture(); f.denyWrite();
  await assert.rejects(f.repair(), /a change may already have been applied/);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 1);
  const unavailable = fixture(); unavailable.denyAudit();
  await assert.rejects(unavailable.repair(), /Audit unavailable/);
  assert.equal(unavailable.calls.filter(call => call.method !== "GET").length, 0);
});
